// One-step creates: registration that carries the note's Yjs state (plan
// "one-step-note-sync", 5.1 and 5.3). Pure: no I/O, so vitest runs it in Node.
//
// A server advertising `notes-with-state` (GET /health `features`) accepts an
// optional `state` (base64 `Y.encodeStateAsUpdate`) and `textSha256` per item on
// `POST /api/notes` and `POST /api/vaults/:id/notes/batch`, writes the row AND
// the first CRDT state in the same request, and answers per item with `seeded`,
// `content` and `sv`. That removes the "row with no content" window and the
// per-note socket the old flow opened for every new note.
//
// The client's side of the contract lives here:
//   * `packSeedChunks` — which items share a request (100 items / 4 MiB
//     decoded; an item over 4 MiB goes alone up to MAX_NOTE_BYTES; past that it
//     carries no state and becomes the caller's permanent failure).
//   * `classifySeedResult` — what one item's answer means for the client.
//
// Safety: the client NEVER marks a note pushed before the response says so. A
// crash between the server's write and the response leaves the note unpushed;
// the retry re-sends the same state and the server answers `covered`.

import { BATCH_MAX_DECODED_BYTES } from "./pool";

/** Items per request when any item carries state (server: 100). */
export const SEED_BATCH_MAX_ITEMS = 100;
/** Decoded state bytes per multi-item request (server: 4 MiB). */
export const SEED_BATCH_MAX_BYTES = BATCH_MAX_DECODED_BYTES;
/** A single-item request may carry up to the per-note ceiling (MAX_NOTE_MB). */
// Same value as `contentUpload.ts MAX_NOTE_BYTES` (the server's MAX_NOTE_MB);
// not imported, so this pure module does not pull the uploader's graph in.
export const SEED_SINGLE_MAX_BYTES = 10 * 1024 * 1024;

/** What the server's per-item `content` says. Mirrors `seed-on-register.ts`. */
export type SeedContent = "applied" | "covered" | "conflict" | "skipped" | "refused";

/** The additive per-item response fields (absent on an old server). */
export interface SeedResultFields {
  seeded?: boolean;
  content?: SeedContent;
  reason?: string;
  /** base64 state vector the server is PROVEN to cover (present when seeded). */
  sv?: string;
}

export interface SeedSized {
  /** Decoded state length, 0 when the item carries no state. */
  stateBytes: number;
}

/**
 * Split items into requests. Order is preserved within a chunk; an item larger
 * than {@link SEED_BATCH_MAX_BYTES} always travels alone. The caller must have
 * dropped items over {@link SEED_SINGLE_MAX_BYTES} (they carry no state).
 */
export function packSeedChunks<T extends SeedSized>(
  items: readonly T[],
  maxItems = SEED_BATCH_MAX_ITEMS,
  maxBytes = SEED_BATCH_MAX_BYTES,
): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let curBytes = 0;
  for (const it of items) {
    if (it.stateBytes > maxBytes) {
      out.push([it]); // single-item request, up to MAX_NOTE_MB
      continue;
    }
    if (cur.length > 0 && (cur.length >= maxItems || curBytes + it.stateBytes > maxBytes)) {
      out.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(it);
    curBytes += it.stateBytes;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * What one registered item needs next.
 *
 *  - `seeded`  — `applied` or `covered`: markPushed + recordAck(sv). No push.
 *  - `merge`   — `conflict` on our own id, or `adopted` onto another id: the
 *                server holds content we have not seen. HTTP pull-then-merge;
 *                local state must NEVER be applied blindly (note doubling).
 *  - `legacy`  — no `seeded` field (old server) or no state was sent: today's
 *                flow (announce `created`, push through docs/batch or uploader).
 *  - `none`    — refused or skipped for a reason that is not content (the
 *                registration outcome decides, as today).
 */
export type SeedNext = "seeded" | "merge" | "legacy" | "none";

export function classifySeedResult(
  status: string,
  fields: SeedResultFields,
  sentState: boolean,
  /** The returned row is the id we sent (created, or our own half-registered row). */
  sameId: boolean,
): SeedNext {
  if (!sentState || typeof fields.seeded !== "boolean") return "legacy";
  if (fields.seeded && (fields.content === "applied" || fields.content === "covered")) {
    // `covered` on a retry arrives as `adopted` of our OWN id: still a success.
    return "seeded";
  }
  if (fields.content === "conflict") return "merge";
  // Adopted onto ANOTHER id (path or case-variant winner): that row may hold a
  // teammate's text. Pull it first; the server wrote none of ours.
  if (status === "adopted" && !sameId) return "merge";
  return "none";
}

/** Decode the server's base64 `sv`. Undecodable ⇒ null (no ack, conservative). */
export function base64ToBytes(b64: string | undefined): Uint8Array | null {
  if (!b64) return null;
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
