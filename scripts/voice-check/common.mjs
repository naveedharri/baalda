// Shared plumbing for the voice live check. Talks to the server exactly the way
// the desktop client does — no privileged endpoints, no test-only server code.

export const BASE = process.env.SERVER_URL ?? "http://localhost:3010";
export const VAULT_ID = process.env.VAULT_ID;
export const VOICE_FRAME = 0x01;

if (!VAULT_ID) {
  console.error("VAULT_ID is required. Find it with:");
  console.error(`  docker exec context-pg psql -U context -d context -c "select id, name from vaults;"`);
  process.exit(1);
}

/** Better Auth rejects a request with no Origin, which Node's fetch omits. */
const headers = (extra = {}) => ({ "Content-Type": "application/json", Origin: BASE, ...extra });

export async function signIn(email, password) {
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!body.token) throw new Error(`sign-in failed for ${email}: ${JSON.stringify(body)}`);
  return body.token;
}

export async function vaultToken(sessionToken) {
  const res = await fetch(`${BASE}/api/vault-sync-token`, {
    method: "POST",
    headers: headers({ Authorization: `Bearer ${sessionToken}` }),
    body: JSON.stringify({ vaultId: VAULT_ID }),
  });
  const body = await res.json();
  if (!body.token) throw new Error(`vault token refused: ${JSON.stringify(body)}`);
  return body.token;
}

export function wsUrl() {
  return `${BASE.replace(/^http/, "ws")}/vault-sync`;
}

export function encodeVoiceFrame(header, audio) {
  const h = Buffer.from(JSON.stringify(header), "utf8");
  const out = Buffer.alloc(3 + h.length + audio.length);
  out[0] = VOICE_FRAME;
  out[1] = (h.length >> 8) & 0xff;
  out[2] = h.length & 0xff;
  h.copy(out, 3);
  audio.copy(out, 3 + h.length);
  return out;
}

export function decodeVoiceFrame(bytes) {
  if (bytes.length < 3 || bytes[0] !== VOICE_FRAME) return null;
  const hLen = (bytes[1] << 8) | bytes[2];
  if (bytes.length < 3 + hLen) return null;
  return {
    header: JSON.parse(Buffer.from(bytes.subarray(3, 3 + hLen)).toString("utf8")),
    audioBytes: bytes.length - 3 - hLen,
  };
}

/** `ws` isn't hoisted under pnpm, so resolve it from the server workspace. */
export async function loadWs() {
  const { createRequire } = await import("node:module");
  const require = createRequire(new URL("../../app/apps/server/package.json", import.meta.url));
  return require("ws");
}
