import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_HEADER_BYTES,
  BootstrapCodecError,
  decodeBootstrapPage,
  encodeBootstrapPage,
  encodedDocBytes,
} from "../src/sync/bulk-protocol.js";

/**
 * The bootstrap page codec. These fixtures are the SERVER half of a
 * hand-mirrored pair — the desktop's `bootstrapCodec.test.ts` asserts the same
 * bytes — so anything asserted here is part of the wire contract, not an
 * implementation detail.
 */
describe("bootstrap page codec", () => {
  const doc = (docId: string, relPath: string, update: number[]) => ({
    docId,
    relPath,
    update: new Uint8Array(update),
  });

  it("round-trips an empty page", () => {
    const bytes = encodeBootstrapPage([]);
    expect(bytes.length).toBe(BOOTSTRAP_HEADER_BYTES);
    expect(decodeBootstrapPage(bytes)).toEqual([]);
  });

  it("round-trips docs, including non-ASCII paths and empty updates", () => {
    const docs = [
      doc("a".repeat(36), "Projects/Läufe/ünïcode.md", [1, 2, 3, 250]),
      doc("b".repeat(36), "root.md", []),
      doc("c", "a/b/c.md", Array.from({ length: 1000 }, (_, i) => i % 256)),
    ];
    expect(decodeBootstrapPage(encodeBootstrapPage(docs))).toEqual(docs);
  });

  it("header is the agreed layout: magic, version, flags, count", () => {
    const bytes = encodeBootstrapPage([doc("x", "x.md", [7])]);
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x42, 0x4c, 0x44, 0x42]); // "BLDB"
    expect(bytes[4]).toBe(1); // ver
    expect(bytes[5]).toBe(0); // flags
    expect(new DataView(bytes.buffer).getUint32(6, true)).toBe(1); // docCount
  });

  it("encodedDocBytes predicts the page size exactly", () => {
    const docs = [doc("id-1", "Nötes/a.md", [1, 2, 3]), doc("id-2", "b.md", [4])];
    const predicted = docs.reduce((n, d) => n + encodedDocBytes(d), BOOTSTRAP_HEADER_BYTES);
    expect(encodeBootstrapPage(docs).length).toBe(predicted);
  });

  // Refusing rather than guessing is the point: a future flag could mean a V2
  // update, and Yjs would mis-apply those silently.
  it("refuses a bad magic, an unknown version, an unknown flag and a truncated page", () => {
    const good = encodeBootstrapPage([doc("x", "x.md", [1, 2, 3])]);
    const badMagic = good.slice();
    badMagic[0] = 0;
    expect(() => decodeBootstrapPage(badMagic)).toThrow(BootstrapCodecError);
    const badVersion = good.slice();
    badVersion[4] = 2;
    expect(() => decodeBootstrapPage(badVersion)).toThrow(/unsupported page version/);
    const badFlags = good.slice();
    badFlags[5] = 1;
    expect(() => decodeBootstrapPage(badFlags)).toThrow(/unsupported page flags/);
    expect(() => decodeBootstrapPage(good.subarray(0, good.length - 1))).toThrow(/truncated/);
    expect(() => decodeBootstrapPage(new Uint8Array(3))).toThrow(/truncated/);
  });

  // A decoded update outlives the page buffer (it goes to Yjs, and on the
  // desktop to Rust). A view would pin the whole 4 MB page for one doc.
  it("decoded updates do not alias the page buffer", () => {
    const page = encodeBootstrapPage([doc("x", "x.md", [9, 9, 9])]);
    const [out] = decodeBootstrapPage(page);
    page.fill(0);
    expect(Array.from(out.update)).toEqual([9, 9, 9]);
  });
});
