// The wire format for the binary IPC commands, both directions.
//
// Yjs updates, CRDT snapshots and attachment bytes used to cross `invoke` as
// JSON number arrays (`Array.from(bytes)` outbound, `number[]` inbound). The
// largest doc on the vault this was measured against holds 17.7 MB of CRDT,
// which is ≈62 MB of JSON text to serialize and parse for one note open, and
// ~40 docs there are over 1 MB. Raw bytes cost none of that.
//
// This module is pure functions with no Tauri import on purpose: `ipc.ts` stays
// a thin `invoke` surface, and the codec is unit-testable in Node. Its tests
// (`src/lib/__tests__/ipcCodec.test.ts`) assert the SAME byte fixtures as the
// Rust round-trip tests in `commands.rs`, so both halves are pinned to one wire
// format rather than to each other's bugs.

/**
 * Build the `[u32 metaLen][meta JSON][bytes…]` frame the binary-inbound
 * commands take (see `commands.rs` `raw_frame`).
 *
 * The command arguments ride in the frame rather than as `invoke` args or
 * headers, for two reasons. Tauri sends a raw body only when the WHOLE payload
 * is bytes — a `Uint8Array` field inside an args object is JSON-ified via
 * `Array.from`, which is exactly the cost being removed — and with a raw body
 * every ordinary deserialize-arg fails by design. Headers are not the answer
 * either: the postMessage fallback transport re-encodes the payload as JSON and
 * treats headers differently, so a header-based design would work right up
 * until the custom-protocol IPC is blocked. A framed prefix behaves the same on
 * both transports.
 *
 * `parts` are concatenated in order; the receiving command's meta says where
 * they split (`snapshotLen`, per-entry lengths).
 */
export function frame(
  meta: unknown,
  ...parts: readonly Uint8Array[]
): Uint8Array {
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  const bodyLen = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(4 + metaBytes.byteLength + bodyLen);
  new DataView(out.buffer).setUint32(0, metaBytes.byteLength, true);
  out.set(metaBytes, 4);
  let off = 4 + metaBytes.byteLength;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

/** A doc's persisted CRDT state, decoded from the frame Rust returns. */
export interface YjsState {
  /** Latest merged snapshot as raw Yjs update bytes, or null if none. */
  snapshot: Uint8Array | null;
  /** Every update logged since that snapshot, oldest first. */
  updates: Uint8Array[];
  /** `updates.length` — the bridge compacts past its threshold after load. */
  updateCount: number;
}

/**
 * Decode `load_yjs_state`'s frame (see `commands.rs` `encode_yjs_state`):
 *
 * ```text
 * [u8 hasSnapshot][u32 snapshotLen][snapshot][u32 count]{[u32 len][bytes]}*
 * ```
 *
 * Little-endian. `hasSnapshot` is a flag byte rather than a length sentinel
 * because a zero-length snapshot and a missing snapshot are different states:
 * recording a state vector for a never-snapshotted doc leaves a NULL snapshot
 * row, and the bridge treats "no snapshot" as "replay the update log".
 *
 * Every returned view ALIASES `buf` rather than copying: Yjs only reads these
 * bytes, and the views together span the buffer anyway, so a copy would double
 * the peak cost on exactly the biggest docs. The corollary is that writing into
 * one of these arrays would corrupt its neighbours — don't.
 */
export function decodeYjsState(buf: ArrayBuffer): YjsState {
  const view = new DataView(buf);
  let off = 0;
  const hasSnapshot = view.getUint8(off) === 1;
  off += 1;
  const snapshotLen = view.getUint32(off, true);
  off += 4;
  const snapshot = hasSnapshot ? new Uint8Array(buf, off, snapshotLen) : null;
  off += snapshotLen;
  const count = view.getUint32(off, true);
  off += 4;
  const updates: Uint8Array[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const len = view.getUint32(off, true);
    off += 4;
    updates[i] = new Uint8Array(buf, off, len);
    off += len;
  }
  return { snapshot, updates, updateCount: count };
}

/**
 * Decode `list_yjs_state_vectors`'s frame (see `commands.rs`
 * `encode_state_vectors`):
 *
 * ```text
 * [u32 count]{[u32 idLen][id utf8][u32 svLen][sv bytes]}*
 * ```
 *
 * One launch reads one row per doc the vault holds CRDT for (6,283 on the
 * measured vault), which is why the manifest is worth not sending as JSON.
 */
export function decodeStateVectors(
  buf: ArrayBuffer,
): Array<{ docId: string; stateVector: Uint8Array }> {
  const view = new DataView(buf);
  const decoder = new TextDecoder();
  let off = 0;
  const count = view.getUint32(off, true);
  off += 4;
  const out = new Array<{ docId: string; stateVector: Uint8Array }>(count);
  for (let i = 0; i < count; i++) {
    const idLen = view.getUint32(off, true);
    off += 4;
    const docId = decoder.decode(new Uint8Array(buf, off, idLen));
    off += idLen;
    const svLen = view.getUint32(off, true);
    off += 4;
    out[i] = { docId, stateVector: new Uint8Array(buf, off, svLen) };
    off += svLen;
  }
  return out;
}
