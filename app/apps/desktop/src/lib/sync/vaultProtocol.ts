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
  /**
   * Feature flags this build understands. The server withholds any NEW binary
   * frame type from a client that didn't list it — without that, an older build
   * would run a voice chunk through {@link decodeUpdateFrame} and apply the
   * garbage as a doc update. Releases auto-update, so old builds stay live.
   */
  caps?: string[];
}

/** What this build can handle beyond the original protocol. Sent in `hello`. */
export const CLIENT_CAPS = ["voice"];

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

// ---- Voice broadcast (mirror of the server's framing) --------------------
//
//   [0x01 VOICE][headerLen u16 BE][header JSON utf8][audio bytes]
//
// Ephemeral by construction: chunks are played as they arrive and dropped. The
// client never writes them to disk, the CRDT, or the index.

export const VOICE_FRAME = 0x01;

/** Chunk header. Short keys — this rides on every chunk (~10/s while talking). */
export interface VoiceHeader {
  /** Transmission id: groups the chunks of one press-and-hold. */
  s: string;
  /** Chunk index within the transmission, from 0. */
  n: number;
  /** 1 on the final chunk (button released). */
  f?: 0 | 1;
  /** Audio encoding, e.g. `"pcm16"`. First chunk only. */
  fmt?: string;
  /** Sample rate in Hz. First chunk only. */
  sr?: number;
  /** Speaker's user id — inbound only; the server stamps it from the token. */
  u?: string;
  /** Speaker's display name. Inbound, first chunk only. */
  m?: string;
  /** Speaker's presence colour. Inbound, first chunk only. */
  c?: string;
}

export interface VoiceFrame {
  header: VoiceHeader;
  audio: Uint8Array;
}

export function encodeVoiceFrame(header: VoiceHeader, audio: Uint8Array): Uint8Array {
  const h = enc.encode(JSON.stringify(header));
  const out = new Uint8Array(3 + h.length + audio.length);
  out[0] = VOICE_FRAME;
  out[1] = (h.length >> 8) & 0xff;
  out[2] = h.length & 0xff;
  out.set(h, 3);
  out.set(audio, 3 + h.length);
  return out;
}

/** Decode an inbound voice frame; null if it isn't one. Never throws. */
export function decodeVoiceFrame(bytes: Uint8Array): VoiceFrame | null {
  if (bytes.length < 3 || bytes[0] !== VOICE_FRAME) return null;
  const hLen = (bytes[1] << 8) | bytes[2];
  if (bytes.length < 3 + hLen) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(dec.decode(bytes.subarray(3, 3 + hLen)));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const h = parsed as Record<string, unknown>;
  if (typeof h.s !== "string" || !h.s) return null;
  if (typeof h.n !== "number" || !Number.isInteger(h.n) || h.n < 0) return null;
  // `u` is required inbound: an unattributed chunk can't be shown or grouped.
  if (typeof h.u !== "string" || !h.u) return null;
  return {
    header: {
      s: h.s,
      n: h.n,
      ...(h.f === 1 ? { f: 1 as const } : {}),
      ...(typeof h.fmt === "string" ? { fmt: h.fmt } : {}),
      ...(typeof h.sr === "number" ? { sr: h.sr } : {}),
      u: h.u,
      ...(typeof h.m === "string" ? { m: h.m } : {}),
      ...(typeof h.c === "string" ? { c: h.c } : {}),
    },
    audio: bytes.subarray(3 + hLen),
  };
}

/**
 * True when a binary frame from the server is voice rather than a doc update.
 *
 * The two share the binary path and only the first byte separates them. That is
 * unambiguous because a doc-update frame opens with `docIdLen` as u16 BE and the
 * server caps doc ids at 0xff bytes, so its high byte is always 0x00 — never
 * {@link VOICE_FRAME}. Don't relax that cap without changing this.
 */
export function isVoiceFrame(bytes: Uint8Array): boolean {
  return bytes.length > 0 && bytes[0] === VOICE_FRAME;
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
