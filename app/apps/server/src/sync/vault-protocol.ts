// Framing for the vault replication channel (spec 05 §3.1). Two wire surfaces,
// both binary-first so Yjs updates never get base64-inflated on the hot path:
//
//   1. WebSocket frames (server <-> client):
//        - control: JSON text frames (handshake, ready, drop, error)
//        - data:    binary frames  [docIdLen u16 BE][docId utf8][update bytes]
//   2. PubSub payloads (server <-> server, across instances):
//        [type u8][ ...type-specific ... ]
//        0x01 update    -> [0x01][docIdLen u16 BE][docId][update]
//        0x02 acl-change-> [0x02]            (vault-wide; connections re-eval)
//
// Keeping every byte layout here makes the channel logic small and the framing
// unit-testable without a socket or Redis.

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---- WebSocket control frames (JSON text) ----

/** Client's opening frame: proves access + declares what it already has. */
export interface HelloFrame {
  t: "hello";
  token: string;
  /** docId -> base64 state vector, for docs the client already holds. */
  manifest: Record<string, string>;
  /** Optional recently-touched docIds to backfill first (spec 05 §4). */
  priority?: string[];
}

export type ServerControl =
  | { t: "ready" } // initial backfill drained
  | { t: "drop"; docId: string } // access lost / doc removed -> client evicts
  | { t: "err"; message: string };

export function parseHello(text: string): HelloFrame | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    !v ||
    typeof v !== "object" ||
    (v as { t?: unknown }).t !== "hello" ||
    typeof (v as { token?: unknown }).token !== "string" ||
    typeof (v as { manifest?: unknown }).manifest !== "object" ||
    (v as { manifest: unknown }).manifest === null
  ) {
    return null;
  }
  const f = v as HelloFrame;
  return {
    t: "hello",
    token: f.token,
    manifest: f.manifest ?? {},
    priority: Array.isArray(f.priority) ? f.priority : undefined,
  };
}

// ---- WebSocket data frame (binary) ----

export function encodeWsUpdate(docId: string, update: Uint8Array): Uint8Array {
  return frameDocPayload(docId, update);
}

export function decodeWsUpdate(
  bytes: Uint8Array,
): { docId: string; update: Uint8Array } | null {
  return unframeDocPayload(bytes);
}

// ---- PubSub payloads (binary, cross-instance) ----

export const PS_UPDATE = 0x01;
export const PS_ACL_CHANGED = 0x02;

export function encodePubsubUpdate(docId: string, update: Uint8Array): Uint8Array {
  const body = frameDocPayload(docId, update);
  const out = new Uint8Array(1 + body.length);
  out[0] = PS_UPDATE;
  out.set(body, 1);
  return out;
}

export function encodePubsubAclChanged(): Uint8Array {
  return new Uint8Array([PS_ACL_CHANGED]);
}

export type PubsubMessage =
  | { type: "update"; docId: string; update: Uint8Array }
  | { type: "acl-changed" };

export function decodePubsub(bytes: Uint8Array): PubsubMessage | null {
  if (bytes.length < 1) return null;
  switch (bytes[0]) {
    case PS_UPDATE: {
      const parsed = unframeDocPayload(bytes.subarray(1));
      return parsed ? { type: "update", ...parsed } : null;
    }
    case PS_ACL_CHANGED:
      return { type: "acl-changed" };
    default:
      return null;
  }
}

// ---- shared [docIdLen u16 BE][docId][rest] framing ----

function frameDocPayload(docId: string, update: Uint8Array): Uint8Array {
  const id = enc.encode(docId);
  if (id.length > 0xffff) throw new Error("docId too long to frame");
  const out = new Uint8Array(2 + id.length + update.length);
  out[0] = (id.length >> 8) & 0xff;
  out[1] = id.length & 0xff;
  out.set(id, 2);
  out.set(update, 2 + id.length);
  return out;
}

function unframeDocPayload(
  bytes: Uint8Array,
): { docId: string; update: Uint8Array } | null {
  if (bytes.length < 2) return null;
  const idLen = (bytes[0] << 8) | bytes[1];
  if (bytes.length < 2 + idLen) return null;
  const docId = dec.decode(bytes.subarray(2, 2 + idLen));
  const update = bytes.subarray(2 + idLen);
  return { docId, update };
}
