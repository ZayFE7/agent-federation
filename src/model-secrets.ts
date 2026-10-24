// Provider keys are encrypted before they touch SQLite. The key is derived from
// the deployment's agent key, which is already the root secret for this install.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function keyFrom(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Empty input stays empty; a real key becomes `v1.<iv>.<cipher>`. */
export async function encryptSecret(secret: string, plaintext: string): Promise<string> {
  if (!plaintext) return "";
  if (!secret) throw new Error("no agent key available to encrypt provider keys");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFrom(secret);
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plaintext)
  );
  return `v1.${toBase64(iv)}.${toBase64(new Uint8Array(cipher))}`;
}

/** The plaintext key, or empty when the value is missing or unreadable. */
export async function decryptSecret(secret: string, payload: string): Promise<string> {
  if (!payload) return "";
  if (!secret) return "";
  const [version, ivPart, cipherPart] = payload.split(".");
  if (version !== "v1" || !ivPart || !cipherPart) return "";
  try {
    const key = await keyFrom(secret);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(ivPart) },
      key,
      fromBase64(cipherPart)
    );
    return decoder.decode(plain);
  } catch {
    return "";
  }
}

/** What the browser sees instead of the key. */
export function keyHint(value: string): string {
  if (!value) return "";
  return value.length <= 4 ? "••••" : `••••${value.slice(-4)}`;
}
