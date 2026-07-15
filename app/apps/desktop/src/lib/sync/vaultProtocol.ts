// Client half of the vault replication channel framing (spec 05 §3.1). Mirrors
// the server's `sync/vault-protocol.ts`: JSON text control frames + binary data
// frames [docIdLen u16 BE][docId utf8][update bytes]. Kept tiny and pure so the
// engine's socket handling is unit-testable without a real WebSocket.

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface HelloFrame {
  t: "hello";
  token: string;
  /** docId -> base64 state vector for docs the client already holds. */
  manifest: Record<string, string>;
  /** Recently-touched docIds to backfill first (spec 05 §4). */
  priority?: string[];
}

export type ServerControl =
  | { t: "ready" }
  | { t: "drop"; docId: string }
  | { t: "err"; message: string };

export function encodeHello(frame: Omit<HelloFrame, "t">): string {
  return JSON.stringify({ t: "hello", ...frame });
}

/** Parse a server text control frame; null if it isn't one we recognise. */
export function parseServerControl(text: string): ServerControl | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const t = (v as { t?: unknown }).t;
  if (t === "ready") return { t: "ready" };
  if (t === "drop" && typeof (v as { docId?: unknown }).docId === "string") {
    return { t: "drop", docId: (v as { docId: string }).docId };
  }
  if (t === "err" && typeof (v as { message?: unknown }).message === "string") {
    return { t: "err", message: (v as { message: string }).message };
  }
  return null;
}

/** Decode a binary data frame from the server into {docId, update}. */
export function decodeUpdateFrame(
  bytes: Uint8Array,
): { docId: string; update: Uint8Array } | null {
  if (bytes.length < 2) return null;
  const idLen = (bytes[0] << 8) | bytes[1];
  if (bytes.length < 2 + idLen) return null;
  const docId = dec.decode(bytes.subarray(2, 2 + idLen));
  const update = bytes.subarray(2 + idLen);
  return { docId, update };
}

/** base64 <-> bytes helpers (browser `atob`/`btoa`, Node `Buffer` fallback). */
export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }
  return Buffer.from(bytes).toString("base64");
}

export { enc as textEncoder };
