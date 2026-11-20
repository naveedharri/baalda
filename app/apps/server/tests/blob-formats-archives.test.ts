// #407: tarballs, gzip and 7z are surfaced by the desktop (vault.rs
// ALLOWED_EXTS) and upload with their own Content-Type; the server must store
// them as archives and the byte sniff must agree with that declaration.
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  CATEGORY_MAX_BYTES,
  EXT_MIME,
  categoryForMime,
  isAllowedMime,
  maxBytesForMime,
  mimeMatchesBytes,
  sniffMime,
} from "../src/blobs/formats.js";

/** One ustar header block (plus an empty body) with a valid checksum. */
function tarBytes(): Uint8Array {
  const block = Buffer.alloc(1024);
  block.write("hello.txt", 0, "ascii");
  block.write("0000644\0", 100, "ascii");
  block.write("0000000\0", 108, "ascii");
  block.write("0000000\0", 116, "ascii");
  block.write("00000000000\0", 124, "ascii");
  block.write("00000000000\0", 136, "ascii");
  block.write("        ", 148, "ascii");
  block.write("0", 156, "ascii");
  block.write("ustar\u000000", 257, "ascii");
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += block[i];
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return block;
}

describe("archive formats (#407)", () => {
  const cases = [
    ["tar", "application/x-tar"],
    ["tgz", "application/gzip"],
    ["gz", "application/gzip"],
    ["7z", "application/x-7z-compressed"],
  ] as const;

  it("maps each extension to an allowed archive MIME with the archive cap", () => {
    for (const [ext, mime] of cases) {
      expect(EXT_MIME[ext], ext).toBe(mime);
      expect(isAllowedMime(mime), mime).toBe(true);
      expect(categoryForMime(mime), mime).toBe("archive");
      expect(maxBytesForMime(mime), mime).toBe(CATEGORY_MAX_BYTES.archive);
    }
    expect(isAllowedMime("application/x-gzip")).toBe(true);
    expect(categoryForMime("application/x-gzip")).toBe("archive");
  });

  it("sniffs real archive bytes as what the desktop declares", async () => {
    const gz = gzipSync(Buffer.from("hello"));
    const tgz = gzipSync(Buffer.from(tarBytes()));
    const sevenZ = Buffer.concat([
      Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04]),
      Buffer.alloc(64),
    ]);
    const tar = tarBytes();
    for (const [bytes, declared] of [
      [gz, "application/gzip"],
      [tgz, "application/gzip"],
      [sevenZ, "application/x-7z-compressed"],
      [tar, "application/x-tar"],
    ] as const) {
      const sniffed = await sniffMime(bytes);
      expect(sniffed, declared).not.toBeNull();
      expect(mimeMatchesBytes(declared, sniffed), `${declared} sniffed as ${sniffed}`).toBe(true);
    }
    expect(mimeMatchesBytes("application/x-gzip", "application/gzip")).toBe(true);
    // A tarball is not a zip: the equivalence groups must not blur them.
    expect(mimeMatchesBytes("application/zip", "application/x-tar")).toBe(false);
  });
});
