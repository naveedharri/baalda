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
  /**
   * This app instance's id (`ApiClient.getClientId()`), the same value sent as
   * `x-baalda-origin` on registry writes. Lets the server skip telling us to
   * re-pull a structural change we made ourselves.
   */
  origin?: string;
}

/** A teammate's live "who's viewing what" state (mirror of the server type).
 *  `docId` null means the user isn't viewing anything (or left) — clear them. */
export interface PresenceState {
  userId: string;
  docId: string | null;
  name: string;
  color: string;
  status: string;
}

export type ServerControl =
  | { t: "ready" }
  | { t: "drop"; docId: string }
  | { t: "reauth" }
  | { t: "registry" }
  | { t: "member"; name: string }
  | ({ t: "presence" } & PresenceState)
  | { t: "err"; message: string };

export function encodeHello(frame: Omit<HelloFrame, "t">): string {
  return JSON.stringify({ t: "hello", ...frame });
}

/** Encode this client's presence frame (which note we're currently viewing).
 *  `userId` is omitted — the server stamps it from our authenticated token. */
export function encodePresence(frame: {
  docId: string | null;
  name: string;
  color: string;
  status: string;
}): string {
  return JSON.stringify({ t: "presence", ...frame });
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
  if (t === "reauth") return { t: "reauth" };
  if (t === "registry") return { t: "registry" };
  if (t === "member" && typeof (v as { name?: unknown }).name === "string") {
    return { t: "member", name: (v as { name: string }).name };
  }
  if (t === "presence") {
    const o = v as Record<string, unknown>;
    if (
      typeof o.userId === "string" &&
      (o.docId === null || typeof o.docId === "string") &&
      typeof o.name === "string" &&
      typeof o.color === "string" &&
      typeof o.status === "string"
    ) {
      return {
        t: "presence",
        userId: o.userId,
        docId: (o.docId as string | null) ?? null,
        name: o.name,
        color: o.color,
        status: o.status,
      };
    }
    return null;
  }
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
