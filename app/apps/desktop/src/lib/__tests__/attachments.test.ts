// What a dropped/pasted file becomes: the bytes on disk, the markdown in the
// note, and — the part with teeth — the refusal when it is too big.
//
// The size gate exists because the server caps a blob at 25 MB
// (`MAX_BLOB_BYTES`). Without it a 40 MB video was written happily, embedded in
// the note, and then failed every upload pass forever: the note referenced a
// file no teammate would ever receive, and nothing ever said so.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  writeBinaryFile: vi.fn(async (_rel: string, _bytes: Uint8Array) => {}),
  readExternalFile: vi.fn(async (_path: string) => new Uint8Array([1, 2, 3])),
}));
vi.mock("../ipc", () => ipc);

import { AttachmentTooLargeError, embedDroppedFile, saveAttachment } from "../attachments";
import { clearToasts, getToasts } from "../toast";

beforeEach(() => {
  ipc.writeBinaryFile.mockClear();
  ipc.readExternalFile.mockClear();
  ipc.readExternalFile.mockImplementation(async () => new Uint8Array([1, 2, 3]));
});
afterEach(() => clearToasts());

describe("saveAttachment", () => {
  it("writes under attachments/<16 hex>.<ext> and returns the vault-root src", async () => {
    const src = await saveAttachment(new Uint8Array([1, 2, 3]), "png");
    expect(src).toMatch(/^\/attachments\/[0-9a-f]{16}\.png$/);
    expect(ipc.writeBinaryFile).toHaveBeenCalledTimes(1);
    expect(ipc.writeBinaryFile.mock.calls[0][0]).toBe(src.slice(1));
  });

  it("is content-addressed: the same bytes name the same file", async () => {
    const a = await saveAttachment(new Uint8Array([9, 9]), "pdf");
    const b = await saveAttachment(new Uint8Array([9, 9]), "pdf");
    expect(a).toBe(b);
  });

  it("refuses an oversize file BEFORE writing, with exactly one error toast", async () => {
    const tooBig = new Uint8Array(26 * 1024 * 1024); // > the 25 MB attachment cap
    await expect(saveAttachment(tooBig, "mp4")).rejects.toBeInstanceOf(
      AttachmentTooLargeError,
    );
    expect(ipc.writeBinaryFile).not.toHaveBeenCalled();
    const toasts = getToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].tone).toBe("error");
    // Errors are sticky (ttl 0) — a size refusal the user blinked past becomes
    // "the drop did nothing" in a bug report.
    expect(toasts[0].ttl).toBe(0);
    expect(toasts[0].text).toMatch(/26 MB/);
    expect(toasts[0].text).toMatch(/25 MB/);
  });

  it("lets a note-family file use the larger note ceiling", async () => {
    // `.txt` is a note (10 MB), not an attachment — and 11 MB is over BOTH, so
    // this pins that the gate reads the registry per extension.
    await expect(saveAttachment(new Uint8Array(11 * 1024 * 1024), "txt")).rejects.toThrow();
    expect(getToasts()[0].text).toMatch(/10 MB/);
  });
});

describe("embedDroppedFile", () => {
  const cases: Array<[string, RegExp]> = [
    // Rendered in place by live preview → the `![]()` embed form.
    ["/host/photo.png", /^!\[photo\]\(\/attachments\/[0-9a-f]{16}\.png\)$/],
    ["/host/spec.pdf", /^!\[spec\]\(\/attachments\/[0-9a-f]{16}\.pdf\)$/],
    ["/host/clip.mp4", /^!\[clip\]\(\/attachments\/[0-9a-f]{16}\.mp4\)$/],
    ["/host/rows.csv", /^!\[rows\]\(\/attachments\/[0-9a-f]{16}\.csv\)$/],
    // Nothing draws these in a note → a plain link, extension kept visible,
    // because the name is all the reader gets.
    ["/host/report.docx", /^\[report\.docx\]\(\/attachments\/[0-9a-f]{16}\.docx\)$/],
    ["/host/bundle.zip", /^\[bundle\.zip\]\(\/attachments\/[0-9a-f]{16}\.zip\)$/],
  ];
  for (const [path, shape] of cases) {
    it(`embeds ${path.split("/").pop()} in the right form`, async () => {
      expect(await embedDroppedFile(path)).toMatch(shape);
    });
  }

  it("propagates the size refusal so the caller can skip just this file", async () => {
    ipc.readExternalFile.mockImplementation(async () => new Uint8Array(26 * 1024 * 1024));
    await expect(embedDroppedFile("/host/huge.mov")).rejects.toBeInstanceOf(
      AttachmentTooLargeError,
    );
    expect(ipc.writeBinaryFile).not.toHaveBeenCalled();
  });
});
