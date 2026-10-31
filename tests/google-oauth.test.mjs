// Google OAuth helpers against a recording fake fetch. Covers the exact auth
// URL parameters, form-encoded token calls, userinfo headers, readable error
// classification, and the rule that credentials never leak into messages.

import assert from "node:assert/strict";
import {
  buildGoogleAuthUrl,
  classifyGoogleError,
  exchangeGoogleCode,
  fetchGoogleUserInfo,
  refreshGoogleToken,
  revokeGoogleToken,
} from "../src/google-oauth.ts";
import {
  GMAIL_SCOPE,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  GOOGLE_USERINFO_URL,
} from "../src/google-types.ts";

const SCOPE = "openid email profile https://mail.google.com/";
const CALLBACK = "https://blip.example/api/connections/google/callback";
const CLIENT_ID = "client-id-1";
const CLIENT_SECRET = "client-secret-1";

const failures = [];
async function checkAsync(name, fn) {
  try {
    await fn();
    console.log("  PASS " + name);
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
    console.log("  FAIL " + name);
  }
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(status, body) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain" },
  });
}

function recordingFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const headers = new Headers(init.headers);
    const body = typeof init.body === "string" ? init.body : "";
    const call = {
      url: String(url),
      method: init.method ?? "GET",
      headers,
      body,
      index: calls.length,
    };
    calls.push(call);
    return handler(call);
  };
  impl.calls = calls;
  return impl;
}

async function expectReject(action, pattern, forbidden = []) {
  let error = null;
  try {
    await action();
  } catch (err) {
    error = err;
  }
  assert.ok(error, "expected the call to reject");
  const message = error && error.message ? error.message : String(error);
  assert.match(message, pattern);
  for (const value of forbidden) {
    assert.ok(
      !message.includes(value),
      `error message leaked a credential: ${message}`
    );
  }
  return message;
}

await checkAsync("auth URL carries the full scope, offline access, state, and login hint", () => {
  const url = new URL(
    buildGoogleAuthUrl({
      clientId: CLIENT_ID,
      redirectUri: CALLBACK,
      state: "state-1",
      loginHint: "owner@example.com",
    })
  );
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  const params = url.searchParams;
  assert.equal(params.get("client_id"), CLIENT_ID);
  assert.equal(params.get("redirect_uri"), CALLBACK);
  assert.equal(params.get("response_type"), "code");
  assert.equal(params.get("scope"), GMAIL_SCOPE);
  assert.equal(params.get("scope"), SCOPE);
  assert.equal(params.get("access_type"), "offline");
  assert.equal(params.get("prompt"), "consent select_account");
  assert.equal(params.get("include_granted_scopes"), "true");
  assert.equal(params.get("state"), "state-1");
  assert.equal(params.get("login_hint"), "owner@example.com");
  assert.equal(params.get("code_challenge"), null, "no PKCE in the web-server flow");
  assert.equal(params.get("code_challenge_method"), null);
  assert.equal(params.get("client_secret"), null);
});

await checkAsync("login hint is optional and blank hints are omitted", () => {
  const base = { clientId: CLIENT_ID, redirectUri: CALLBACK, state: "state-2" };
  const without = new URL(buildGoogleAuthUrl(base)).searchParams;
  assert.equal(without.has("login_hint"), false);

  const blank = new URL(buildGoogleAuthUrl({ ...base, loginHint: "   " })).searchParams;
  assert.equal(blank.has("login_hint"), false);

  assert.throws(
    () => buildGoogleAuthUrl({ ...base, state: "" }),
    /OAuth state is required/i
  );
});

await checkAsync("code exchange posts the exact form and parses tokens", async () => {
  const fake = recordingFetch(({ url, method, headers, body }) => {
    assert.equal(url, GOOGLE_TOKEN_URL);
    assert.equal(method, "POST");
    assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded");
    assert.equal(headers.get("accept"), "application/json");
    const form = new URLSearchParams(body);
    assert.equal(form.get("grant_type"), "authorization_code");
    assert.equal(form.get("code"), "auth-code-1");
    assert.equal(form.get("client_id"), CLIENT_ID);
    assert.equal(form.get("client_secret"), CLIENT_SECRET);
    assert.equal(form.get("redirect_uri"), CALLBACK);
    assert.equal(form.has("code_verifier"), false);
    assert.equal(form.has("code_challenge"), false);
    return jsonResponse(200, {
      access_token: "access-1",
      refresh_token: "refresh-1",
      expires_in: 3599,
      scope: SCOPE,
      token_type: "Bearer",
    });
  });

  const tokens = await exchangeGoogleCode(
    {
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      code: "auth-code-1",
      redirectUri: CALLBACK,
    },
    fake
  );
  assert.deepEqual(tokens, {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresIn: 3599,
    scopes: ["openid", "email", "profile", "https://mail.google.com/"],
  });
  assert.equal(fake.calls.length, 1);
});

await checkAsync("refresh posts the refresh form without a code or redirect", async () => {
  const fake = recordingFetch(({ url, method, headers, body }) => {
    assert.equal(url, GOOGLE_TOKEN_URL);
    assert.equal(method, "POST");
    assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded");
    const form = new URLSearchParams(body);
    assert.equal(form.get("grant_type"), "refresh_token");
    assert.equal(form.get("refresh_token"), "refresh-1");
    assert.equal(form.get("client_id"), CLIENT_ID);
    assert.equal(form.get("client_secret"), CLIENT_SECRET);
    assert.equal(form.has("code"), false);
    assert.equal(form.has("redirect_uri"), false);
    return jsonResponse(200, {
      access_token: "access-2",
      expires_in: "1800",
      scope: "openid https://mail.google.com/",
    });
  });

  const tokens = await refreshGoogleToken(
    { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: "refresh-1" },
    fake
  );
  assert.deepEqual(tokens, {
    accessToken: "access-2",
    expiresIn: 1800,
    scopes: ["openid", "https://mail.google.com/"],
  });
  assert.equal("refreshToken" in tokens, false, "absent refresh tokens stay absent");
});

await checkAsync("userinfo sends the bearer header and returns sub/email/profile", async () => {
  const fake = recordingFetch(({ url, method, headers }) => {
    assert.equal(url, GOOGLE_USERINFO_URL);
    assert.equal(method, "GET");
    assert.equal(headers.get("authorization"), "Bearer access-1");
    assert.equal(headers.get("accept"), "application/json");
    return jsonResponse(200, {
      sub: "google-sub-1",
      email: "owner@example.com",
      name: "Owner",
      picture: "https://example.com/owner.png",
    });
  });

  const info = await fetchGoogleUserInfo("access-1", fake);
  assert.deepEqual(info, {
    sub: "google-sub-1",
    email: "owner@example.com",
    name: "Owner",
    picture: "https://example.com/owner.png",
  });
});

await checkAsync("userinfo rejects missing sub or email and never echoes the token", async () => {
  for (const payload of [
    { email: "owner@example.com" },
    { sub: "google-sub-1" },
  ]) {
    const fake = recordingFetch(() => jsonResponse(200, payload));
    await expectReject(
      () => fetchGoogleUserInfo("access-secret-1", fake),
      /sub|email/i,
      ["access-secret-1"]
    );
  }
});

await checkAsync("invalid_grant is classified as reconnect required without secrets", async () => {
  const fake = recordingFetch(() =>
    jsonResponse(400, {
      error: "invalid_grant",
      error_description: "Token has been expired or revoked.",
    })
  );
  await expectReject(
    () =>
      exchangeGoogleCode(
        {
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          code: "auth-code-secret",
          redirectUri: CALLBACK,
        },
        fake
      ),
    /invalid_grant/i,
    ["auth-code-secret", CLIENT_SECRET]
  ).then((message) => assert.match(message, /reconnect/i));

  const direct = classifyGoogleError(
    400,
    JSON.stringify({ error: "invalid_grant", error_description: "expired" })
  );
  assert.match(direct, /invalid_grant/);
  assert.match(direct, /reconnect/i);
});

await checkAsync("HTTP and malformed responses fail clearly and sanitize server text", async () => {
  const server = recordingFetch(() => textResponse(500, "backend exploded"));
  await expectReject(
    () =>
      exchangeGoogleCode(
        {
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          code: "code-http-secret",
          redirectUri: CALLBACK,
        },
        server
      ),
    /HTTP 500/,
    ["code-http-secret", CLIENT_SECRET]
  ).then((message) => assert.match(message, /backend exploded/));

  const limited = classifyGoogleError(429, "slow down");
  assert.match(limited, /429/);
  assert.match(limited, /rate/i);

  const malformed = recordingFetch(() => textResponse(200, "not json"));
  await expectReject(
    () =>
      exchangeGoogleCode(
        {
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          code: "code-json-secret",
          redirectUri: CALLBACK,
        },
        malformed
      ),
    /unreadable token response/i,
    ["code-json-secret", CLIENT_SECRET]
  );

  const missing = recordingFetch(() =>
    jsonResponse(200, { refresh_token: "refresh-missing", expires_in: 3600, scope: SCOPE })
  );
  await expectReject(
    () =>
      exchangeGoogleCode(
        {
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          code: "code-missing-secret",
          redirectUri: CALLBACK,
        },
        missing
      ),
    /access token/i,
    ["refresh-missing", "code-missing-secret", CLIENT_SECRET]
  );
});

await checkAsync("network failures are readable and drop the underlying secret-bearing error", async () => {
  const offline = async () => {
    throw new Error("socket reset for refresh-1 and client-secret-1");
  };
  await expectReject(
    () =>
      refreshGoogleToken(
        { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: "refresh-1" },
        offline
      ),
    /network|reach/i,
    ["refresh-1", CLIENT_SECRET]
  );

  await expectReject(
    () => fetchGoogleUserInfo("access-1", offline),
    /network|reach/i,
    ["access-1"]
  );
});

await checkAsync("userinfo HTTP errors redact the access token in server detail", async () => {
  const fake = recordingFetch(() =>
    textResponse(401, "access_token=access-secret-2 invalid")
  );
  await expectReject(
    () => fetchGoogleUserInfo("access-secret-2", fake),
    /HTTP 401/,
    ["access-secret-2"]
  );
});

await checkAsync("error text is capped at 300 characters", () => {
  const plain = classifyGoogleError(500, "x".repeat(1000));
  assert.ok(plain.length <= 300, `plain message was ${plain.length} chars`);
  assert.ok(!plain.includes("x".repeat(301)), "server text was not truncated");

  const json = classifyGoogleError(
    500,
    JSON.stringify({ error: "server_error", error_description: "y".repeat(1000) })
  );
  assert.ok(json.length <= 300, `json message was ${json.length} chars`);
  assert.ok(!json.includes("y".repeat(301)), "description was not truncated");

  const redacted = classifyGoogleError(
    400,
    JSON.stringify({
      error: "invalid_grant",
      error_description:
        "refresh_token=refresh-raw access_token=access-raw client_secret=secret-raw",
    })
  );
  assert.ok(!redacted.includes("refresh-raw"));
  assert.ok(!redacted.includes("access-raw"));
  assert.ok(!redacted.includes("secret-raw"));
});

await checkAsync("common Google errors get readable classifications", () => {
  assert.match(
    classifyGoogleError(401, JSON.stringify({ error: "invalid_client" })),
    /invalid_client/
  );
  assert.match(
    classifyGoogleError(400, { error: "invalid_grant", error_description: "expired" }),
    /invalid_grant/
  );
  assert.match(
    classifyGoogleError(400, JSON.stringify({ error: "redirect_uri_mismatch" })),
    /redirect URI/
  );
  assert.match(
    classifyGoogleError(403, JSON.stringify({ error: "insufficient_scope" })),
    /Gmail permissions/
  );
  assert.match(classifyGoogleError(401, ""), /HTTP 401/);
  assert.match(classifyGoogleError(503, ""), /temporarily unavailable/);
});

await checkAsync("revoke posts the token form and returns false on every failure", async () => {
  const ok = recordingFetch(({ url, method, headers, body }) => {
    assert.equal(url, GOOGLE_REVOKE_URL);
    assert.equal(method, "POST");
    assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded");
    assert.equal(new URLSearchParams(body).get("token"), "refresh-revoke-1");
    return new Response("", { status: 200 });
  });
  assert.equal(await revokeGoogleToken("refresh-revoke-1", ok), true);
  assert.equal(ok.calls.length, 1);

  const rejected = recordingFetch(() => textResponse(400, "invalid_token"));
  assert.equal(await revokeGoogleToken("refresh-revoke-1", rejected), false);

  const offline = async () => {
    throw new Error("network down for refresh-revoke-1");
  };
  assert.equal(await revokeGoogleToken("refresh-revoke-1", offline), false);

  let called = false;
  const never = async () => {
    called = true;
    return new Response("", { status: 200 });
  };
  assert.equal(await revokeGoogleToken("", never), false);
  assert.equal(called, false);
});

if (failures.length) {
  for (const failure of failures) console.error("  FAIL " + failure);
  console.log(`google oauth: ${failures.length} failed`);
  process.exit(1);
}
console.log("google oauth: passed");
