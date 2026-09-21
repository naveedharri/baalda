// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { portableNoteCopy } from "./copy";
import { importClipboardAttachments } from "./paste";

describe("portable note clipboard", () => {
  it("carries images and files into another vault with the prose", async () => {
    const bytes = new Uint8Array([1, 2, 255]);
    const read = vi.fn(async () => bytes);
    const markdown = "# Hello\n\nBefore ![photo](../attachments/a.png)\n\n[Report](/attachments/b.pdf)";
    const copy = await portableNoteCopy(markdown, "Folder/note.md", read);
    expect(copy.html).toContain("data:image/png;base64,AQL/");
    expect(copy.html).toContain("data:application/pdf;base64,AQL/");
    expect(copy.text).toBe(markdown);
    const save = vi.fn(async (_bytes: Uint8Array, ext: string) => `/attachments/new.${ext}`);
    const pasted = await importClipboardAttachments(copy.html, save);
    expect(pasted).toContain("Hello");
    expect(pasted).toContain("Before");
    expect(pasted).toContain("/attachments/new.png");
    expect(pasted).toContain("/attachments/new.pdf");
    expect(save).toHaveBeenCalledWith(bytes, "png");
    expect(save).toHaveBeenCalledWith(bytes, "pdf");
  });

  it("deduplicates references and strips executable HTML", async () => {
    const read = vi.fn(async () => new Uint8Array([1]));
    const copy = await portableNoteCopy('![a](/attachments/a.png) ![b](/attachments/a.png)\n\n<img src="x" onerror="alert(1)"><script>alert(1)</script>', "note.md", read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(copy.html).not.toMatch(/onerror|script|alert/);
    const save = vi.fn(async () => "/attachments/new.png");
    await importClipboardAttachments(copy.html, save);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("does not read URLs or paths outside attachments", async () => {
    const read = vi.fn();
    await portableNoteCopy('![a](../../secret.png) ![b](https://example.com/a.png) ![c](/.context/private.png)', "note.md", read);
    expect(read).not.toHaveBeenCalled();
  });

  it("carries images embedded using HTML markup", async () => {
    const copy = await portableNoteCopy('<img src="/attachments/a.png" alt="photo">', "note.md", async () => new Uint8Array([1]));
    expect(copy.html).toContain('src="data:image/png;base64,AQ=="');
  });

  it("reports missing bytes", async () => {
    await expect(portableNoteCopy('![a](/attachments/missing.png)', "note.md", async () => { throw new Error("Missing image"); })).rejects.toThrow("Missing image");
  });
});
