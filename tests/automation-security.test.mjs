// Contract for src/automation-security.ts: secrets, HMAC, body caps, URL guard,
// and header redaction. Plain Node, no framework.

import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import {
  bodyHash,
  generateSecret,
  redactHeaders,
  safeFetchUrl,
  safeIngressBody,
  secretHint,
  verifyGithubSignature,
  verifySecret,
} from "../src/automation-security.ts";

const encoder = new TextEncoder();
const failures = [];
let checks = 0;

async function check(name, fn) {
  checks += 1;
  try {
    await fn();
  } catch (error) {
    failures.push(`${name}: ${error && error.message ? error.message : String(error)}`);
  }
}

await check("generateSecret returns 32 random bytes as unpadded base64url", () => {
  const first = generateSecret();
  const second = generateSecret();
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(first.includes("="), false);
  assert.equal(Buffer.from(first, "base64url").length, 32);
  assert.notEqual(first, second);
});

await check("secretHint is the last four characters and never the secret", () => {
  const secret = generateSecret();
  assert.equal(secretHint(secret), secret.slice(-4));
  assert.notEqual(secretHint(secret), secret);
  assert.equal(secretHint(""), "");
  assert.notEqual(secretHint("abcd"), "abcd");
});

await check("verifySecret accepts only an exact non-empty match", () => {
  const secret = generateSecret();
  assert.equal(verifySecret(secret, secret), true);
  assert.equal(verifySecret(`${secret}x`, secret), false);
  assert.equal(verifySecret("", secret), false);
  assert.equal(verifySecret(secret, ""), false);
  assert.equal(verifySecret("", ""), false);
});

await check("verifyGithubSignature accepts a valid sha256 HMAC", async () => {
  const secret = "test-secret-value";
  const body = encoder.encode('{"action":"opened"}');
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(await verifyGithubSignature(body, `sha256=${signature}`, secret), true);
});

await check("verifyGithubSignature rejects wrong body, secret, and missing header", async () => {
  const secret = "test-secret-value";
  const body = encoder.encode('{"action":"opened"}');
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(
    await verifyGithubSignature(encoder.encode("other"), `sha256=${signature}`, secret),
    false
  );
  assert.equal(await verifyGithubSignature(body, `sha256=${signature}`, "wrong"), false);
  assert.equal(await verifyGithubSignature(body, null, secret), false);
  assert.equal(await verifyGithubSignature(body, undefined, secret), false);
  assert.equal(await verifyGithubSignature(body, `sha256=${signature}`, ""), false);
});

await check("verifyGithubSignature rejects sha1 and malformed headers", async () => {
  const secret = "test-secret-value";
  const body = encoder.encode("payload");
  const sha1 = createHmac("sha1", secret).update(body).digest("hex");
  const sha256 = createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(await verifyGithubSignature(body, `sha1=${sha1}`, secret), false);
  assert.equal(await verifyGithubSignature(body, sha256, secret), false);
  assert.equal(await verifyGithubSignature(body, `sha256=${sha256.slice(0, 63)}`, secret), false);
  assert.equal(await verifyGithubSignature(body, `sha256=${sha256}0`, secret), false);
  assert.equal(await verifyGithubSignature(body, `sha256=${"z".repeat(64)}`, secret), false);
  assert.equal(await verifyGithubSignature(body, `SHA256=${sha256}`, secret), false);
});

await check("safeIngressBody accepts exactly 128 KB and rejects one byte more", () => {
  const max = 128 * 1024;
  assert.deepEqual(safeIngressBody("a".repeat(max)), { ok: true, bytes: max });
  const over = safeIngressBody("a".repeat(max + 1));
  assert.equal(over.ok, false);
  assert.equal(over.error, "too_large");
  assert.equal(over.bytes, max + 1);
  assert.deepEqual(safeIngressBody(""), { ok: true, bytes: 0 });
});

await check("safeIngressBody counts UTF-8 bytes, not characters", () => {
  const max = 128 * 1024;
  const exact = "é".repeat(max / 2);
  assert.deepEqual(safeIngressBody(exact), { ok: true, bytes: max });
  const over = safeIngressBody(`${exact}a`);
  assert.equal(over.ok, false);
  assert.equal(over.bytes, max + 1);
});

await check("safeFetchUrl rejects unsafe schemes, credentials, and private hosts", () => {
  const rejected = [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "ftp://example.com/file",
    "https://user:pass@example.com/hook",
    "https://user@example.com/hook",
    "https://:pass@example.com/hook",
    "http://localhost",
    "http://localhost:8787/hook",
    "http://api.localhost/hook",
    "http://printer.local/hook",
    "http://127.0.0.1/hook",
    "http://127.9.9.9/hook",
    "http://10.0.0.1/hook",
    "http://10.255.255.255/hook",
    "http://192.168.0.1/hook",
    "http://169.254.169.254/latest/meta-data",
    "http://172.16.0.1/hook",
    "http://172.31.255.255/hook",
    "http://0.0.0.0/hook",
    "http://100.64.0.1/hook",
    "http://224.0.0.1/hook",
    "http://255.255.255.255/hook",
    "http://[::1]/hook",
    "http://[::]/hook",
    "http://[fe80::1]/hook",
    "http://[fc00::1]/hook",
    "http://[fd12::1]/hook",
    "http://[ff02::1]/hook",
    "http://[::ffff:127.0.0.1]/hook",
    "http://[::ffff:192.168.1.1]/hook",
    "http://intranet/hook",
    "example.com/hook",
    "//example.com/hook",
    "",
  ];
  for (const input of rejected) {
    assert.equal(safeFetchUrl(input), null, input);
  }
});

await check("safeFetchUrl allows public hostnames and public IP literals", () => {
  const allowed = [
    "https://example.com/hooks/abc",
    "http://example.com",
    "https://8.8.8.8/resolve",
    "https://1.1.1.1/",
    "https://[2606:4700:4700::1111]/dns-query",
    "HTTPS://EXAMPLE.COM/Path",
  ];
  for (const input of allowed) {
    const normalized = safeFetchUrl(input);
    assert.equal(typeof normalized, "string", input);
    assert.match(normalized, /^https?:\/\//i, input);
  }
});

await check("redactHeaders drops auth, cookies, signatures, and key material", () => {
  const redacted = redactHeaders({
    Authorization: "Bearer abc",
    "Proxy-Authorization": "Basic abc",
    cookie: "sid=1",
    "Set-Cookie": "sid=2",
    "X-Hub-Signature": "sha1=deadbeef",
    "X-Hub-Signature-256": "sha256=deadbeef",
    "X-Api-Key": "k",
    "X-Secret-Token": "t",
    "X-Token-Count": "3",
    "X-Password": "p",
    "Content-Type": "application/json",
    "User-Agent": "GitHub-Hookshot/1",
    "X-GitHub-Event": "push",
  });
  assert.deepEqual(Object.keys(redacted).sort(), [
    "Content-Type",
    "User-Agent",
    "X-GitHub-Event",
  ]);
  assert.equal(redacted.Authorization, undefined);
  assert.equal(redacted["X-Hub-Signature-256"], undefined);
});

await check("redactHeaders caps the serialized result at 8 KB", () => {
  const many = {};
  for (let index = 0; index < 100; index += 1) {
    many[`X-Custom-${index}`] = "a".repeat(500);
  }
  const capped = redactHeaders(many);
  assert.ok(Buffer.byteLength(JSON.stringify(capped), "utf8") <= 8 * 1024);
  assert.ok(Object.keys(capped).length < 100);

  const mixed = redactHeaders({ "X-Huge": "a".repeat(9000), "X-Ok": "yes" });
  assert.equal(mixed["X-Huge"], undefined);
  assert.equal(mixed["X-Ok"], "yes");
});

await check("bodyHash is sha256 hex over string and bytes", async () => {
  const expected = createHash("sha256").update("hello").digest("hex");
  assert.equal(await bodyHash("hello"), expected);
  assert.equal(await bodyHash(encoder.encode("hello")), expected);
});

if (failures.length > 0) {
  for (const failure of failures) console.error("  FAIL " + failure);
  console.error(`automation-security: ${failures.length} of ${checks} checks failed`);
  process.exit(1);
}
console.log(`automation-security: ${checks} checks, 0 failed`);
