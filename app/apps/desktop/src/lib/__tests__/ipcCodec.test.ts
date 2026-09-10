import { describe, expect, it } from "vitest";

import { decodeStateVectors, decodeYjsState, frame } from "../ipcCodec";

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

describe("frame", () => {
  /** `raw_frame`'s side of the wire, so the test reads the frame as Rust does. */
  function split(f: Uint8Array): { meta: unknown; payload: Uint8Array } {
    const metaLen = new DataView(
      f.buffer,
      f.byteOffset,
      f.byteLength,
    ).getUint32(0, true);
    return {
      meta: JSON.parse(new TextDecoder().decode(f.subarray(4, 4 + metaLen))),
      payload: f.subarray(4 + metaLen),
    };
  }

  it("prefixes the meta JSON with its little-endian byte length", () => {
    const f = frame({ docId: "d1", expectedEpoch: 7 }, new Uint8Array([1, 2, 3]));
    const { meta, payload } = split(f);
    expect(meta).toEqual({ docId: "d1", expectedEpoch: 7 });
    expect(Array.from(payload)).toEqual([1, 2, 3]);
    // The length really is LE: the same fixture Rust's
    // `raw_frame_splits_meta_and_body` reads.
    const metaLen = JSON.stringify({ docId: "d1", expectedEpoch: 7 }).length;
    expect(Array.from(f.subarray(0, 4))).toEqual([metaLen, 0, 0, 0]);
  });

  it("concatenates the parts in order, so lengths in the meta locate them", () => {
    const snapshot = new Uint8Array([9, 9]);
    const stateVector = new Uint8Array([1]);
    const f = frame(
      { docId: "d1", expectedEpoch: null, snapshotLen: snapshot.byteLength },
      snapshot,
      stateVector,
    );
    const { meta, payload } = split(f);
    expect(meta).toMatchObject({ snapshotLen: 2 });
    expect(Array.from(payload)).toEqual([9, 9, 1]);
    expect(Array.from(payload.subarray(0, 2))).toEqual([9, 9]);
    expect(Array.from(payload.subarray(2))).toEqual([1]);
  });

  it("accepts no parts at all — an empty payload is legal", () => {
    const f = frame({ docId: "d1", expectedEpoch: null });
    const { payload } = split(f);
    expect(payload.byteLength).toBe(0);
    // Rust's `raw_frame` requires at least the four length bytes; this has them.
    expect(f.byteLength).toBeGreaterThan(4);
  });

  it("counts multi-byte meta in bytes, not characters", () => {
    const f = frame({ docId: "notité-🔒", expectedEpoch: null }, new Uint8Array([5]));
    const { meta, payload } = split(f);
    expect(meta).toEqual({ docId: "notité-🔒", expectedEpoch: null });
    expect(Array.from(payload)).toEqual([5]);
  });
});

describe("decodeYjsState", () => {
  it("reads the empty state — the shortest legal frame", () => {
    // flag 0 + snapshotLen 0 + count 0 = nine zero bytes.
    const state = decodeYjsState(buf(...new Array(9).fill(0)));
    expect(state.snapshot).toBeNull();
    expect(state.updates).toEqual([]);
    expect(state.updateCount).toBe(0);
  });

  it("reads updates with no snapshot", () => {
    const fixture = buf(
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
    const state = decodeYjsState(fixture);
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
    const fixture = buf(
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
    const state = decodeYjsState(fixture);
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
    const fixture = buf(1, ...u32(1), 7, ...u32(1), ...u32(2), 8, 9);
    const state = decodeYjsState(fixture);
    expect(state.snapshot!.buffer).toBe(fixture);
    expect(state.updates[0].buffer).toBe(fixture);
  });
});

describe("decodeStateVectors", () => {
  it("reads an empty manifest as a bare count", () => {
    expect(decodeStateVectors(buf(...u32(0)))).toEqual([]);
  });

  it("reads ids as utf-8 by byte length, not char count", () => {
    const id1 = Array.from(new TextEncoder().encode("doc-1"));
    const id2 = Array.from(new TextEncoder().encode("notité-🔒"));
    const fixture = buf(
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
    const rows = decodeStateVectors(fixture);
    expect(rows).toHaveLength(2);
    expect(rows[0].docId).toBe("doc-1");
    expect(Array.from(rows[0].stateVector)).toEqual([1, 2, 3]);
    // A multi-byte id: 11 bytes, 8 characters — reading char counts would slip.
    expect(rows[1].docId).toBe("notité-🔒");
    expect(id2.length).not.toBe("notité-🔒".length);
    expect(rows[1].stateVector.byteLength).toBe(0);
  });
});
