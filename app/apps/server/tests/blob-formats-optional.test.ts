// #401: the optional file-type groups ("Code and text files", "More file
// types"). Every type a desktop can switch on must be storable here, and its
// bytes must sniff as what the desktop declares, or a switched-on vault would
// bounce every upload with 415.
import { describe, expect, it } from "vitest";
import { EXT_MIME, categoryForMime, hasMagicSignature, isAllowedMime, mimeMatchesBytes, sniffMime } from "../src/blobs/formats.js";

const B = (...p: Array<string | number[]>) =>
  Buffer.concat(p.map((x) => (typeof x === "string" ? Buffer.from(x, "latin1") : Buffer.from(x))));
const pad = (b: Buffer, n = 4096) => Buffer.concat([b, Buffer.alloc(Math.max(0, n - b.length))]);

/** A zip of STORED entries (local headers only; enough for a sniff). */
function storedZip(entries: Array<[string, string]>): Buffer {
  const parts: Buffer[] = [];
  for (const [name, data] of entries) {
    const n = Buffer.from(name, "latin1");
    const d = Buffer.from(data, "latin1");
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt32LE(d.length, 18);
    h.writeUInt32LE(d.length, 22);
    h.writeUInt16LE(n.length, 26);
    parts.push(h, n, d);
  }
  return Buffer.concat(parts);
}

const cfb = pad(B([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
const SAMPLES: Array<[string, Buffer]> = [
  ["ttf", pad(B([0, 1, 0, 0, 0, 0x0c, 0, 0x80]))],
  ["otf", pad(B("OTTO", [0, 0x0c, 0, 0x80]))],
  ["woff", pad(B("wOFF", [0, 1, 0, 0]))],
  ["woff2", pad(B("wOF2", [0, 1, 0, 0]))],
  ["psd", pad(B("8BPS", [0, 1]))],
  ["ai", pad(B("%PDF-1.5\n%AI"))],
  ["eps", pad(B("%!PS-Adobe-3.0 EPSF-3.0\n"))],
  ["sketch", storedZip([["document.json", "{}"]])],
  ["doc", cfb],
  ["xls", cfb],
  ["ppt", cfb],
  ["odt", storedZip([["mimetype", "application/vnd.oasis.opendocument.text"], ["content.xml", "<x/>"]])],
  ["epub", storedZip([["mimetype", "application/epub+zip"], ["META-INF/container.xml", "<x/>"]])],
  ["rtf", pad(B("{\\rtf1\\ansi hello}"))],
  [
    "mkv",
    pad(
      B(
        [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2, 0x81, 0x04, 0x42, 0xf3, 0x81, 0x08, 0x42, 0x82, 0x88],
        "matroska",
        [0x42, 0x87, 0x81, 0x04, 0x42, 0x85, 0x81, 0x02],
      ),
    ),
  ],
  ["avi", pad(B("RIFF", [0, 0, 0, 0], "AVI LIST"))],
  [
    "opus",
    pad(B("OggS", [0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0x13], "OpusHead", [1, 2, 0, 0])),
  ],
  ["aiff", pad(B("FORM", [0, 0, 0, 0], "AIFFCOMM"))],
  ["rar", pad(B("Rar!", [0x1a, 0x07, 0x00]))],
  ["bz2", pad(B("BZh91AY&SY"))],
  ["xz", pad(B([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0x00, 0x04]))],
];

describe("optional file types (#401)", () => {
  it("stores every new binary type, and its bytes sniff as what the desktop declares", async () => {
    for (const [ext, bytes] of SAMPLES) {
      const declared = EXT_MIME[ext];
      expect(declared, ext).toBeTruthy();
      expect(isAllowedMime(declared), ext).toBe(true);
      const sniffed = await sniffMime(new Uint8Array(bytes));
      expect(mimeMatchesBytes(declared, sniffed), `${ext}: ${declared} sniffed as ${sniffed}`).toBe(true);
    }
  });

  it("files design and office types under the document ceiling, not the photo one", () => {
    for (const ext of ["psd", "ai", "doc", "odt", "epub"]) expect(categoryForMime(EXT_MIME[ext]), ext).toBe("document");
    for (const ext of ["rar", "bz2", "xz"]) expect(categoryForMime(EXT_MIME[ext]), ext).toBe("archive");
  });

  it("never sniffs a code or text file, and accepts the old TypeScript spelling", () => {
    for (const ext of ["ts", "rb", "swift", "kt", "ini", "log", "tex", "ipynb", "jsonl", "xslt", "vtt"]) {
      const mime = EXT_MIME[ext];
      expect(mime?.startsWith("text/"), ext).toBe(true);
      expect(hasMagicSignature(mime), ext).toBe(false);
      expect(isAllowedMime(mime), ext).toBe(true);
    }
    expect(isAllowedMime("text/typescript")).toBe(true);
  });

  it("keeps unrelated containers apart", () => {
    expect(mimeMatchesBytes("application/msword", "application/zip")).toBe(false);
    expect(mimeMatchesBytes("font/ttf", "font/otf")).toBe(false);
  });
});
