// GoogleStore over real node:sqlite through the SqlHandle adapter used across
// the suite. Covers schema, OAuth state lifetime, reconnect, defaults, delete
// promotion, public redaction, and account resolution.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  GoogleStore,
  ensureGoogleSchema,
  publicAccount,
} from "../src/google-store.ts";

const SCOPE = "https://mail.google.com/";
const SCOPES = JSON.stringify(["openid", "email", "profile", SCOPE]);

const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log("  PASS " + name);
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
    console.log("  FAIL " + name);
  }
}

function freshStore() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query, ...bindings) {
      const parts = query.split("?");
      if (parts.length !== bindings.length + 1) throw new Error("placeholder mismatch");
      return { results: db.prepare(parts.join("?")).all(...bindings) };
    },
  };
  const store = new GoogleStore(sql);
  ensureGoogleSchema(sql);
  store.ensureSchema();
  return { store, sql, db };
}

function account(id, sub, email, over = {}) {
  return {
    id,
    google_sub: sub,
    email,
    name: `Name ${id}`,
    picture: null,
    refresh_enc: `enc-${id}`,
    scopes: SCOPES,
    is_default: 0,
    status: "active",
    last_error: null,
    last_refresh_at: null,
    created_at: 1000,
    updated_at: 1000,
    ...over,
  };
}

function rawInsert(sql, row) {
  sql.exec(
    `INSERT INTO google_accounts (
       id, google_sub, email, name, picture, refresh_enc, scopes, is_default,
       status, last_error, last_refresh_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.google_sub,
    row.email,
    row.name,
    row.picture,
    row.refresh_enc,
    row.scopes,
    row.is_default,
    row.status,
    row.last_error,
    row.last_refresh_at,
    row.created_at,
    row.updated_at
  );
}

check("schema is idempotent and has exactly the designed columns", () => {
  const { store, sql } = freshStore();
  store.ensureSchema();

  const accountColumns = sql
    .exec("PRAGMA table_info(google_accounts)")
    .results.map((row) => row.name);
  assert.deepEqual(accountColumns, [
    "id",
    "google_sub",
    "email",
    "name",
    "picture",
    "refresh_enc",
    "scopes",
    "is_default",
    "status",
    "last_error",
    "last_refresh_at",
    "created_at",
    "updated_at",
  ]);

  const stateColumns = sql
    .exec("PRAGMA table_info(google_oauth_states)")
    .results.map((row) => row.name);
  assert.deepEqual(stateColumns, ["state", "redirect_uri", "login_hint", "created_at"]);

  const unique = sql
    .exec("PRAGMA index_list(google_accounts)")
    .results.filter((row) => Number(row.unique) === 1);
  assert.ok(unique.length >= 2, "google_sub and email need unique indexes");
});

check("OAuth state is single use and a duplicate state cannot be inserted", () => {
  const { store, sql } = freshStore();
  const row = {
    state: "state-1",
    redirect_uri: "https://blip.example/api/connections/google/callback",
    login_hint: "owner@example.com",
    created_at: 1000,
  };
  store.createState(row);
  assert.throws(() => store.createState({ ...row }), /UNIQUE|constraint/i);

  const consumed = store.consumeState("state-1", 2000, 600_000);
  assert.deepEqual({ ...consumed }, row);
  assert.equal(store.consumeState("state-1", 2000, 600_000), null);
  const left = sql.exec(
    "SELECT COUNT(*) AS n FROM google_oauth_states WHERE state = ?",
    "state-1"
  ).results[0];
  assert.equal(Number(left.n), 0);
});

check("expired OAuth state is consumed but rejected, and pruning drops only old rows", () => {
  const { store, sql } = freshStore();
  store.createState({
    state: "old",
    redirect_uri: "https://blip.example/callback",
    login_hint: null,
    created_at: 1000,
  });
  store.createState({
    state: "fresh",
    redirect_uri: "https://blip.example/callback",
    login_hint: null,
    created_at: 2000,
  });

  assert.equal(store.consumeState("old", 1000 + 600_001, 600_000), null);
  const oldCount = sql.exec(
    "SELECT COUNT(*) AS n FROM google_oauth_states WHERE state = ?",
    "old"
  ).results[0];
  assert.equal(Number(oldCount.n), 0);

  store.pruneStates(3000, 1500); // cutoff 1500
  const remaining = sql.exec("SELECT state FROM google_oauth_states").results;
  assert.deepEqual(remaining.map((row) => row.state), ["fresh"]);
  assert.equal(store.consumeState("fresh", 3000, 1500)?.state, "fresh");
});

check("first account is default and reconnect preserves identity while refreshing tokens", () => {
  const { store } = freshStore();
  const first = store.upsertAccount(
    account("id-a", "sub-a", "a@example.com", { is_default: 0 })
  );
  assert.equal(first.is_default, 1);
  const second = store.upsertAccount(
    account("id-b", "sub-b", "b@example.com", {
      is_default: 1,
      created_at: 2000,
      updated_at: 2000,
    })
  );
  assert.equal(second.is_default, 0, "only the first account is auto-default");

  store.markStatus("id-a", "reauth_required", "invalid_grant", 1500);

  const reconnected = store.upsertAccount(
    account("brand-new-id", "sub-a", "a@example.com", {
      name: "Owner Name",
      picture: "https://example.com/p.png",
      refresh_enc: "enc-reconnected",
      scopes: JSON.stringify(["openid", SCOPE]),
      status: "reauth_required",
      last_error: "stale error",
      is_default: 0,
      created_at: 9999,
      updated_at: 2500,
    })
  );
  assert.equal(reconnected.id, "id-a", "reconnect keeps the stable account id");
  assert.equal(reconnected.created_at, 1000);
  assert.equal(reconnected.is_default, 1);
  assert.equal(reconnected.name, "Owner Name");
  assert.equal(reconnected.picture, "https://example.com/p.png");
  assert.equal(reconnected.refresh_enc, "enc-reconnected");
  assert.deepEqual(JSON.parse(reconnected.scopes), ["openid", SCOPE]);
  assert.equal(reconnected.status, "active");
  assert.equal(reconnected.last_error, null);
  assert.equal(reconnected.updated_at, 2500);
  assert.equal(store.listAccounts().length, 2);

  const renamed = store.upsertAccount(
    account("another-id", "sub-a", "a-new@example.com", { updated_at: 2600 })
  );
  assert.equal(renamed.id, "id-a");
  assert.equal(renamed.email, "a-new@example.com");
});

check("google_sub and email are unique; an email cannot switch identity silently", () => {
  const { store, sql } = freshStore();
  store.upsertAccount(account("id-a", "sub-a", "a@example.com"));

  assert.throws(
    () => rawInsert(sql, account("dup-sub", "sub-a", "other@example.com")),
    /UNIQUE|constraint/i
  );
  assert.throws(
    () => rawInsert(sql, account("dup-email", "sub-b", "A@EXAMPLE.COM")),
    /UNIQUE|constraint/i
  );
  assert.throws(
    () => store.upsertAccount(account("dup-api", "sub-c", "a@example.com")),
    /already connected/i
  );
  assert.equal(store.listAccounts().length, 1);
});

check("email-matched reconnect updates only the existing row id", () => {
  const { store } = freshStore();
  store.upsertAccount(account("id-a", "sub-a", "a@example.com"));

  const changedSub = store.upsertAccount(
    account("id-a", "sub-a-renamed", "a@example.com", { refresh_enc: "enc-2" })
  );
  assert.equal(changedSub.id, "id-a");
  assert.equal(changedSub.google_sub, "sub-a-renamed");
  assert.equal(changedSub.refresh_enc, "enc-2");

  assert.throws(
    () => store.upsertAccount(account("id-x", "sub-x", "a@example.com")),
    /already connected/i
  );
});

check("setDefault clears every flag and leaves exactly one default", () => {
  const { store, sql } = freshStore();
  store.upsertAccount(account("id-a", "sub-a", "a@example.com", { created_at: 1000 }));
  store.upsertAccount(account("id-b", "sub-b", "b@example.com", { created_at: 2000 }));
  store.upsertAccount(account("id-c", "sub-c", "c@example.com", { created_at: 3000 }));

  assert.equal(store.getAccount("id-a").is_default, 1);
  assert.equal(store.setDefault("id-b"), true);
  assert.equal(store.getAccount("id-a").is_default, 0);
  assert.equal(store.getAccount("id-b").is_default, 1);
  assert.equal(store.getAccount("id-c").is_default, 0);

  assert.equal(store.setDefault("id-c"), true);
  const defaults = sql.exec(
    "SELECT id FROM google_accounts WHERE is_default = 1"
  ).results;
  assert.deepEqual(defaults.map((row) => row.id), ["id-c"]);

  assert.equal(store.setDefault("missing"), false);
  assert.equal(store.getAccount("id-c").is_default, 1);
});

check("deleteAccount promotes the oldest remaining account and handles the last", () => {
  const { store } = freshStore();
  store.upsertAccount(account("id-a", "sub-a", "a@example.com", { created_at: 1000 }));
  store.upsertAccount(account("id-b", "sub-b", "b@example.com", { created_at: 2000 }));
  store.upsertAccount(account("id-c", "sub-c", "c@example.com", { created_at: 3000 }));

  // Deleting a non-default account leaves the current default alone.
  assert.equal(store.deleteAccount("id-c"), true);
  assert.equal(store.getAccount("id-a").is_default, 1);
  assert.equal(store.getAccount("id-b").is_default, 0);

  // Deleting the default promotes the oldest survivor.
  assert.equal(store.deleteAccount("id-a"), true);
  assert.equal(store.getAccount("id-b").is_default, 1);

  assert.equal(store.deleteAccount("id-b"), true);
  assert.equal(store.listAccounts().length, 0);
  assert.equal(store.deleteAccount("id-b"), false);
});

check("listAccounts puts the default first, then the oldest", () => {
  const { store } = freshStore();
  store.upsertAccount(account("id-a", "sub-a", "a@example.com", { created_at: 3000 }));
  store.upsertAccount(account("id-b", "sub-b", "b@example.com", { created_at: 1000 }));
  store.upsertAccount(account("id-c", "sub-c", "c@example.com", { created_at: 2000 }));
  store.setDefault("id-c");

  assert.deepEqual(
    store.listAccounts().map((row) => row.id),
    ["id-c", "id-b", "id-a"]
  );
});

check("publicAccount redacts refresh_enc and google_sub and decodes fields", () => {
  const { store } = freshStore();
  store.upsertAccount(account("id-a", "sub-a", "a@example.com"));
  const row = store.getAccount("id-a");
  const view = publicAccount(row);
  assert.deepEqual(store.publicAccount(row), view);

  assert.ok(!("refresh_enc" in view));
  assert.ok(!("google_sub" in view));
  assert.equal(view.id, "id-a");
  assert.equal(view.email, "a@example.com");
  assert.equal(view.is_default, true);
  assert.deepEqual(view.scopes, ["openid", "email", "profile", SCOPE]);
  assert.ok(!JSON.stringify(view).includes("enc-id-a"));

  const legacy = publicAccount({ ...row, scopes: "openid  email", is_default: 0 });
  assert.deepEqual(legacy.scopes, ["openid", "email"]);
  assert.equal(legacy.is_default, false);
});

check("resolveAccount accepts id and case-insensitive, padded email", () => {
  const { store } = freshStore();
  store.upsertAccount(account("id-a", "sub-a", "a@example.com"));

  assert.equal(store.resolveAccount("id-a").id, "id-a");
  assert.equal(store.resolveAccount("a@example.com").id, "id-a");
  assert.equal(store.resolveAccount("  A@Example.COM  ").id, "id-a");
  assert.equal(store.resolveAccount("missing@example.com"), null);
  assert.equal(store.resolveAccount(""), null);
  assert.equal(store.resolveAccount("   "), null);
});

check("markStatus and updateRefresh persist status, error, scopes, and refresh time", () => {
  const { store } = freshStore();
  store.upsertAccount(account("id-a", "sub-a", "a@example.com"));

  store.markStatus("id-a", "reauth_required", "invalid_grant", 1500);
  let row = store.getAccount("id-a");
  assert.equal(row.status, "reauth_required");
  assert.equal(row.last_error, "invalid_grant");
  assert.equal(row.updated_at, 1500);

  store.updateRefresh("id-a", "enc-rotated", `openid ${SCOPE}`, 1750);
  row = store.getAccount("id-a");
  assert.equal(row.refresh_enc, "enc-rotated");
  assert.deepEqual(store.publicAccount(row).scopes, ["openid", SCOPE]);
  assert.equal(row.status, "active");
  assert.equal(row.last_error, null);
  assert.equal(row.last_refresh_at, 1750);
  assert.equal(row.updated_at, 1750);
  assert.equal(row.is_default, 1);
});

if (failures.length) {
  for (const failure of failures) console.error("  FAIL " + failure);
  process.exit(1);
}
console.log("google store: passed");
