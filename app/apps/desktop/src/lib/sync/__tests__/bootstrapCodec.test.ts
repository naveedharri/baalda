// The bootstrap page format, pinned to BYTES.
//
// This codec has a twin it can never import: the server's
// `src/sync/bulk-protocol.ts`. The only thing that can keep the two honest is a
// fixture written out as hex in both suites, so the fixtures below are the
// contract — copy them verbatim into the server's test rather than re-deriving
// them, and if either side has to change one, both sides change in the same PR.
//
// Little-endian throughout:
//
//   "BLDB" | ver u8 = 1 | flags u8 = 0 | docCount u32 | reserved u16
//   docCount × ( docIdLen u8 | pathLen u16 | updateLen u32
//                | docId utf8 | relPath utf8 | update )

import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_DOC_HEADER_BYTES,
  BOOTSTRAP_HEADER_BYTES,
  BootstrapDecodeError,
  decodeBootstrapPage,
  encodeBootstrapPage,
} from "../bootstrapCodec";

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function unhex(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ── FIXTURE A — one doc ──────────────────────────────────────────────────────
// docId "d1" (2 B), relPath "a.md" (4 B), update 01 02 03 (3 B).
//
//   424c4442  "BLDB"
//   01        version 1
//   00        flags
//   01000000  docCount = 1   (u32 LE)
//   0000      reserved
//   02        docIdLen  = 2  (u8)
//   0400      pathLen   = 4  (u16 LE)
//   03000000  updateLen = 3  (u32 LE)
//   6431      "d1"
//   612e6d64  "a.md"
//   010203    update
const FIXTURE_ONE_DOC = "424c44420100010000000000020400030000006431612e6d64010203";

// ── FIXTURE B — two docs, the second with an EMPTY update ───────────────────
// A zero-length update is legal on the wire (an empty doc the server holds a
// row for) and must decode to a zero-length view, not to a truncation error.
//
//   424c4442 01 00 02000000 0000
//   02 0400 03000000 6431 612e6d64 010203
//   02 0600 00000000 6432 622f632e6d64
const FIXTURE_TWO_DOCS =
  "424c44420100020000000000" +
  "020400030000006431612e6d64010203" +
  "02060000000000" +
  "6432622f632e6d64";

describe("decodeBootstrapPage — the wire fixtures", () => {
  it("decodes the one-doc fixture byte for byte", () => {
    const docs = decodeBootstrapPage(unhex(FIXTURE_ONE_DOC));
    expect(docs).toHaveLength(1);
    expect(docs[0].docId).toBe("d1");
    expect(docs[0].relPath).toBe("a.md");
    expect([...docs[0].update]).toEqual([1, 2, 3]);
  });

  it("re-encodes the one-doc fixture to exactly those bytes", () => {
    const bytes = encodeBootstrapPage([
      { docId: "d1", relPath: "a.md", update: new Uint8Array([1, 2, 3]) },
    ]);
    expect(hex(bytes)).toBe(FIXTURE_ONE_DOC);
  });

  it("decodes two docs, the second carrying an empty update", () => {
    const docs = decodeBootstrapPage(unhex(FIXTURE_TWO_DOCS));
    expect(docs.map((d) => d.docId)).toEqual(["d1", "d2"]);
    expect(docs[1].relPath).toBe("b/c.md");
    expect(docs[1].update.byteLength).toBe(0);
  });

  it("round-trips utf8 outside the BMP in both the id and the path", () => {
    const docs = [
      { docId: "doc-café", relPath: "Notes/日本語 🗂/naïve.md", update: new Uint8Array([9]) },
    ];
    expect(decodeBootstrapPage(encodeBootstrapPage(docs))).toEqual(docs);
  });

  it("does not copy: each update is a view into the page buffer", () => {
    const page = unhex(FIXTURE_ONE_DOC);
    const [doc] = decodeBootstrapPage(page);
    expect(doc.update.buffer).toBe(page.buffer);
  });

  it("header sizes are what the layout says", () => {
    expect(BOOTSTRAP_HEADER_BYTES).toBe(12);
    expect(BOOTSTRAP_DOC_HEADER_BYTES).toBe(7);
    // An empty page is a legal, header-only page.
    expect(decodeBootstrapPage(encodeBootstrapPage([]))).toEqual([]);
  });
});

describe("decodeBootstrapPage — every refusal", () => {
  const good = unhex(FIXTURE_ONE_DOC);

  it("refuses a page that is not one (bad magic)", () => {
    const bad = good.slice();
    bad[0] = 0x00;
    expect(() => decodeBootstrapPage(bad)).toThrow(BootstrapDecodeError);
  });

  it("refuses an unknown version rather than guessing the layout", () => {
    const bad = good.slice();
    bad[4] = 2;
    expect(() => decodeBootstrapPage(bad)).toThrow(/version 2/);
  });

  it("refuses ANY set flag — that is what the byte is reserved for", () => {
    const bad = good.slice();
    bad[5] = 0x01;
    expect(() => decodeBootstrapPage(bad)).toThrow(/flags/);
  });

  it("refuses a truncated body instead of applying half an update", () => {
    expect(() => decodeBootstrapPage(good.slice(0, good.byteLength - 1))).toThrow(
      /truncated/,
    );
  });

  it("refuses a truncated doc header", () => {
    expect(() => decodeBootstrapPage(good.slice(0, BOOTSTRAP_HEADER_BYTES + 3))).toThrow(
      /truncated/,
    );
  });

  it("refuses trailing bytes — the two sides disagree about the layout", () => {
    const bad = new Uint8Array(good.byteLength + 1);
    bad.set(good, 0);
    expect(() => decodeBootstrapPage(bad)).toThrow(/trailing/);
  });

  it("refuses a page shorter than the header", () => {
    expect(() => decodeBootstrapPage(new Uint8Array(4))).toThrow(/too short/);
  });
});
