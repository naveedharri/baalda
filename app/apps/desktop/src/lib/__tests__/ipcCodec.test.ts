import { describe, expect, it } from "vitest";

import { decodeStateVectors, decodeYjsState } from "../ipcCodec";

// These fixtures are the SAME bytes the Rust tests assert
// (`src-tauri/src/commands.rs`: `encode_yjs_state_round_trips`,
// `encode_state_vectors_round_trips`). Written out literally, not produced by
// an encoder in this file, so the two codecs are pinned to one wire format
// instead of to each other's bugs: a change on either side fails here.

/** `[u32]` little-endian, as the frames use it. */
function u32(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
}

function buf(...bytes: number[]): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

describe("decodeYjsState", () => {
  it("reads the empty state — the shortest legal frame", () => {
    // flag 0 + snapshotLen 0 + count 0 = nine zero bytes.
    const state = decodeYjsState(buf(...new Array(9).fill(0)));
    expect(state.snapshot).toBeNull();
    expect(state.updates).toEqual([]);
    expect(state.updateCount).toBe(0);
  });

  it("reads updates with no snapshot", () => {
    const frame = buf(
      0,
      ...u32(0),
      ...u32(3),
      ...u32(2),
      1,
      2,
      ...u32(1),
      3,
      ...u32(3),
      4,
      5,
      6,
    );
    const state = decodeYjsState(frame);
    expect(state.snapshot).toBeNull();
    expect(state.updateCount).toBe(3);
    expect(state.updates.map((u) => Array.from(u))).toEqual([
      [1, 2],
      [3],
      [4, 5, 6],
    ]);
  });

  it("reads a snapshot with no updates", () => {
    const state = decodeYjsState(buf(1, ...u32(3), 9, 9, 9, ...u32(0)));
    expect(Array.from(state.snapshot!)).toEqual([9, 9, 9]);
    expect(state.updates).toEqual([]);
  });

  it("keeps a zero-length update, which is not the end of the frame", () => {
    const frame = buf(
      1,
      ...u32(1),
      7,
      ...u32(2),
      ...u32(0),
      ...u32(3),
      255,
      0,
      128,
    );
    const state = decodeYjsState(frame);
    expect(Array.from(state.snapshot!)).toEqual([7]);
    expect(state.updateCount).toBe(2);
    expect(state.updates[0].byteLength).toBe(0);
    expect(Array.from(state.updates[1])).toEqual([255, 0, 128]);
  });

  it("tells an empty snapshot from a missing one", () => {
    // The flag byte is the only difference; both carry snapshotLen 0.
    const empty = decodeYjsState(buf(1, ...u32(0), ...u32(0)));
    expect(empty.snapshot).not.toBeNull();
    expect(empty.snapshot!.byteLength).toBe(0);
    const missing = decodeYjsState(buf(0, ...u32(0), ...u32(0)));
    expect(missing.snapshot).toBeNull();
  });

  it("returns views over the one response buffer, not copies", () => {
    // Documented behaviour, and the reason the biggest docs cost no extra
    // memory: every view aliases the response. Assert it so a future "just
    // copy it" change has to be deliberate.
    const frame = buf(1, ...u32(1), 7, ...u32(1), ...u32(2), 8, 9);
    const state = decodeYjsState(frame);
    expect(state.snapshot!.buffer).toBe(frame);
    expect(state.updates[0].buffer).toBe(frame);
  });
});

describe("decodeStateVectors", () => {
  it("reads an empty manifest as a bare count", () => {
    expect(decodeStateVectors(buf(...u32(0)))).toEqual([]);
  });

  it("reads ids as utf-8 by byte length, not char count", () => {
    const id1 = Array.from(new TextEncoder().encode("doc-1"));
    const id2 = Array.from(new TextEncoder().encode("notité-🔒"));
    const frame = buf(
      ...u32(2),
      ...u32(id1.length),
      ...id1,
      ...u32(3),
      1,
      2,
      3,
      ...u32(id2.length),
      ...id2,
      ...u32(0),
    );
    const rows = decodeStateVectors(frame);
    expect(rows).toHaveLength(2);
    expect(rows[0].docId).toBe("doc-1");
    expect(Array.from(rows[0].stateVector)).toEqual([1, 2, 3]);
    // A multi-byte id: 11 bytes, 8 characters — reading char counts would slip.
    expect(rows[1].docId).toBe("notité-🔒");
    expect(id2.length).not.toBe("notité-🔒".length);
    expect(rows[1].stateVector.byteLength).toBe(0);
  });
});
