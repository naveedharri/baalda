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
//
// A third surface was added for push-to-talk voice (see "Voice broadcast"
// below): client->server binary frames, which until then were unused entirely.

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
  /**
   * Opaque per-app-instance id, echoed by the client on its registry HTTP writes
   * (`x-baalda-origin`). It lets the channel skip telling a client about a
   * structural change it made itself — a 500-note reconcile used to bounce ~1,100
   * `registry` frames straight back to its author, each costing a full
   * per-subscriber ACL recompute. Absent ⇒ no self-exclusion (older clients).
   */
  origin?: string;
  /**
   * Optional feature flags this client understands, e.g. `["voice"]`.
   *
   * Load-bearing for anything that adds a NEW binary server->client frame. JSON
   * control frames are forward-compatible (an old client's `parseServerControl`
   * returns null for an unknown `t` and ignores it), but the binary path is not:
   * it assumes every binary frame is `[docIdLen u16][docId][update]` and would
   * feed a voice frame straight into `coldApply` as a bogus doc update. Releases
   * auto-update, so old clients stay in the field — the server must only send a
   * new binary frame type to a connection that asked for it.
   */
  caps?: string[];
}

/** A teammate's live "who's viewing what" state, forwarded to every subscriber
 *  of the vault so the sidebar can show presence dots on notes/folders. `docId`
 *  null means "not viewing anything" (or gone) — clients clear that user. The
 *  `userId` is stamped by the server from the token, never trusted from the
 *  client, so presence can't be spoofed. */
export interface PresenceState {
  userId: string;
  docId: string | null;
  name: string;
  color: string;
  status: string;
}

export type ServerControl =
  | { t: "ready" } // initial backfill drained
  | { t: "drop"; docId: string } // access lost / doc removed -> client evicts
  | { t: "reauth" } // ACL changed in this vault -> client re-mints its open doc's token
  | { t: "registry" } // folders/notes structure changed -> client re-pulls the registry
  | { t: "member"; name: string } // a new teammate joined the vault -> refresh + celebrate
  | ({ t: "presence" } & PresenceState) // a teammate's live viewing state changed
  | { t: "err"; message: string };

/** Client's post-hello presence frame: declares what note it's currently on.
 *  `docId` is null when the client has no note open. `userId` is intentionally
 *  absent — the server derives it from the authenticated token. */
export interface PresenceFrame {
  t: "presence";
  docId: string | null;
  name: string;
  color: string;
  status: string;
}

/** Parse a client presence text frame; null if it isn't one. */
export function parsePresence(text: string): PresenceFrame | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.t !== "presence") return null;
  if (o.docId !== null && typeof o.docId !== "string") return null;
  if (typeof o.name !== "string" || typeof o.color !== "string" || typeof o.status !== "string") {
    return null;
  }
  return {
    t: "presence",
    docId: (o.docId as string | null) ?? null,
    name: o.name,
    color: o.color,
    status: o.status,
  };
}

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
    origin: typeof f.origin === "string" && f.origin ? f.origin : undefined,
    caps: Array.isArray(f.caps) ? f.caps.filter((c): c is string => typeof c === "string") : undefined,
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

// ---- Voice broadcast (push-to-talk) ----
//
// Live, EPHEMERAL audio: while a user holds the talk button their client emits
// small chunks that the relay fans out to every other member of the vault, who
// plays them as they land. Nothing is stored — not on the server, not on any
// client. There is no blob, no row, no file, and no history; a chunk that
// arrives while a listener is offline is simply gone.
//
// Frame layout (identical in both directions, so one codec serves both):
//
//   [0x01 VOICE][headerLen u16 BE][header JSON utf8][audio bytes]
//
// The header is JSON because it is tiny and needs to stay extensible; the audio
// stays raw so it is never base64-inflated. Keys are one character because this
// rides once per chunk (~10/s while talking) — see {@link VoiceHeader}.
//
// Client->server headers carry only the transmission id, sequence and end flag.
// The server re-frames with the speaker's identity stamped from the token — the
// same anti-spoofing rule presence follows, and one the note-level ping notably
// does NOT (there, `ping.name` is whatever the sender claims).

/** Type byte for a voice frame. Client->server binary was an unused namespace
 *  before this, so the leading byte keeps room for future frame types. */
export const VOICE_FRAME = 0x01;

/**
 * Largest audio payload accepted in one chunk. At the 16 kHz mono PCM16 the
 * desktop sends (32 KB/s) this is two seconds of speech, so a client using the
 * intended ~10 chunks/s cadence sits ~20x under it; the cap only exists to stop
 * a malicious client from framing something huge.
 */
export const MAX_VOICE_CHUNK_BYTES = 64 * 1024;

/** Per-connection inbound voice budget: bytes per second of audio a single
 *  speaker may push before the relay starts dropping their chunks. 128 KB/s is
 *  4x the intended PCM16 rate, so it never trips on honest traffic. */
export const VOICE_RATE_BYTES_PER_SEC = 128 * 1024;

/** Chunk header. Short keys: this rides on every chunk of every transmission. */
export interface VoiceHeader {
  /** Transmission id — groups the chunks of one press-and-hold into a stream.
   *  Client-chosen and opaque; two people talking at once produce two ids. */
  s: string;
  /** Chunk index within the transmission, from 0. Lets the receiver order
   *  chunks and notice a gap without trusting arrival order. */
  n: number;
  /** 1 on the final chunk (the moment the button came up). */
  f?: 0 | 1;
  /** Audio encoding, e.g. `"pcm16"`. First chunk only. */
  fmt?: string;
  /** Sample rate in Hz. First chunk only. */
  sr?: number;
  /** Speaker's user id. Server->client only, stamped from the token. */
  u?: string;
  /** Speaker's display name. Server->client, first chunk only. */
  m?: string;
  /** Speaker's presence color. Server->client, first chunk only. */
  c?: string;
}

export interface VoiceFrame {
  header: VoiceHeader;
  audio: Uint8Array;
}

export function encodeVoiceFrame(header: VoiceHeader, audio: Uint8Array): Uint8Array {
  const h = enc.encode(JSON.stringify(header));
  if (h.length > 0xffff) throw new Error("voice header too long to frame");
  const out = new Uint8Array(3 + h.length + audio.length);
  out[0] = VOICE_FRAME;
  out[1] = (h.length >> 8) & 0xff;
  out[2] = h.length & 0xff;
  out.set(h, 3);
  out.set(audio, 3 + h.length);
  return out;
}

/** Decode a voice frame; null for anything malformed or not a voice frame.
 *  Never throws — this parses bytes straight off a socket. */
export function decodeVoiceFrame(bytes: Uint8Array): VoiceFrame | null {
  if (bytes.length < 3 || bytes[0] !== VOICE_FRAME) return null;
  const hLen = (bytes[1] << 8) | bytes[2];
  if (bytes.length < 3 + hLen) return null;
  let header: unknown;
  try {
    header = JSON.parse(dec.decode(bytes.subarray(3, 3 + hLen)));
  } catch {
    return null;
  }
  if (!header || typeof header !== "object") return null;
  const h = header as Record<string, unknown>;
  // `s` and `n` are the two fields the relay and the receiver both rely on;
  // everything else is optional metadata that may legitimately be absent.
  if (typeof h.s !== "string" || !h.s) return null;
  if (typeof h.n !== "number" || !Number.isInteger(h.n) || h.n < 0) return null;
  const audio = bytes.subarray(3 + hLen);
  if (audio.length > MAX_VOICE_CHUNK_BYTES) return null;
  return {
    header: {
      s: h.s,
      n: h.n,
      ...(h.f === 1 ? { f: 1 as const } : {}),
      ...(typeof h.fmt === "string" ? { fmt: h.fmt } : {}),
      ...(typeof h.sr === "number" ? { sr: h.sr } : {}),
      ...(typeof h.u === "string" ? { u: h.u } : {}),
      ...(typeof h.m === "string" ? { m: h.m } : {}),
      ...(typeof h.c === "string" ? { c: h.c } : {}),
    },
    audio,
  };
}

// ---- PubSub payloads (binary, cross-instance) ----

export const PS_UPDATE = 0x01;
export const PS_ACL_CHANGED = 0x02;
export const PS_REGISTRY_CHANGED = 0x03;
export const PS_MEMBER_JOINED = 0x04;
export const PS_PRESENCE = 0x05;
export const PS_PRESENCE_QUERY = 0x06;
export const PS_VOICE = 0x07;

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

/**
 * Structure changed in a vault. `origins` names the client(s) whose HTTP writes
 * caused it (see {@link HelloFrame.origin}); a connection self-excludes only when
 * EVERY contributing origin is its own — if two clients changed things inside one
 * coalescing window, both must still hear about the other's change. An empty list
 * means "unknown origin", i.e. notify everyone (the safe default).
 */
export function encodePubsubRegistryChanged(origins: string[] = []): Uint8Array {
  if (origins.length === 0) return new Uint8Array([PS_REGISTRY_CHANGED]);
  const body = enc.encode(JSON.stringify(origins));
  const out = new Uint8Array(1 + body.length);
  out[0] = PS_REGISTRY_CHANGED;
  out.set(body, 1);
  return out;
}

export function encodePubsubMemberJoined(name: string): Uint8Array {
  const n = enc.encode(name);
  const out = new Uint8Array(1 + n.length);
  out[0] = PS_MEMBER_JOINED;
  out.set(n, 1);
  return out;
}

/** Fan a teammate's viewing state out to the vault (JSON body after the type). */
export function encodePubsubPresence(p: PresenceState): Uint8Array {
  const body = enc.encode(JSON.stringify(p));
  const out = new Uint8Array(1 + body.length);
  out[0] = PS_PRESENCE;
  out.set(body, 1);
  return out;
}

/**
 * Fan one voice chunk out to the vault. `frame` is the already-encoded
 * server->client {@link encodeVoiceFrame} payload, speaker identity included,
 * so every instance forwards the exact same bytes it would have sent locally
 * and no re-framing happens on the receiving side.
 */
export function encodePubsubVoice(frame: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + frame.length);
  out[0] = PS_VOICE;
  out.set(frame, 1);
  return out;
}

/** Ask every connection in the vault to re-announce its presence — sent when a
 *  client joins so it learns who's already viewing what (stateless: no instance
 *  holds the whole roster, so newcomers pull it via a re-announce round). */
export function encodePubsubPresenceQuery(): Uint8Array {
  return new Uint8Array([PS_PRESENCE_QUERY]);
}

export type PubsubMessage =
  | { type: "update"; docId: string; update: Uint8Array }
  | { type: "acl-changed" }
  | { type: "registry-changed"; origins: string[] }
  | { type: "member-joined"; name: string }
  | { type: "presence"; presence: PresenceState }
  | { type: "presence-query" }
  | { type: "voice"; frame: Uint8Array; speakerId: string };

export function decodePubsub(bytes: Uint8Array): PubsubMessage | null {
  if (bytes.length < 1) return null;
  switch (bytes[0]) {
    case PS_UPDATE: {
      const parsed = unframeDocPayload(bytes.subarray(1));
      return parsed ? { type: "update", ...parsed } : null;
    }
    case PS_ACL_CHANGED:
      return { type: "acl-changed" };
    case PS_REGISTRY_CHANGED: {
      if (bytes.length === 1) return { type: "registry-changed", origins: [] };
      try {
        const parsed: unknown = JSON.parse(dec.decode(bytes.subarray(1)));
        const origins = Array.isArray(parsed)
          ? parsed.filter((o): o is string => typeof o === "string")
          : [];
        return { type: "registry-changed", origins };
      } catch {
        // Unparseable origin list ⇒ fall back to notifying everyone.
        return { type: "registry-changed", origins: [] };
      }
    }
    case PS_MEMBER_JOINED:
      return { type: "member-joined", name: dec.decode(bytes.subarray(1)) };
    case PS_PRESENCE: {
      try {
        const p = JSON.parse(dec.decode(bytes.subarray(1))) as PresenceState;
        if (typeof p?.userId !== "string") return null;
        return { type: "presence", presence: p };
      } catch {
        return null;
      }
    }
    case PS_PRESENCE_QUERY:
      return { type: "presence-query" };
    case PS_VOICE: {
      // Copy: the frame is forwarded to sockets after this buffer may be reused,
      // and a subarray would keep the whole pubsub payload alive besides.
      const frame = bytes.slice(1);
      const parsed = decodeVoiceFrame(frame);
      // The speaker id is what lets a connection skip echoing audio back to the
      // person talking, so a frame without one is unusable, not merely odd.
      if (!parsed?.header.u) return null;
      return { type: "voice", frame, speakerId: parsed.header.u };
    }
    default:
      return null;
  }
}

// ---- shared [docIdLen u16 BE][docId][rest] framing ----

function frameDocPayload(docId: string, update: Uint8Array): Uint8Array {
  const id = enc.encode(docId);
  // Bounded at 0xff, not 0xffff, and that is load-bearing rather than tidiness:
  // doc-update and voice frames share the one binary path to the client, which
  // tells them apart by the first byte. Capping the id length here pins the
  // update frame's high length byte to 0x00, so VOICE_FRAME (0x01) can never
  // collide with it. Ids are UUID/Better-Auth TEXT (~32-36 bytes), so the real
  // ceiling is ~7x what anything actually uses.
  if (id.length > 0xff) throw new Error("docId too long to frame");
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
