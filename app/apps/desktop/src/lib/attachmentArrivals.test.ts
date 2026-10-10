import { describe, expect, it } from "vitest";
import { isAttachmentWanted, onAttachmentWanted, wantAttachment } from "./attachmentArrivals";

describe("wanted attachments", () => {
  it("counts every image waiting on a path and tells the fetcher each time", () => {
    const heard: string[] = [];
    const off = onAttachmentWanted((p) => heard.push(p));
    const a = wantAttachment("attachments/x.png");
    const b = wantAttachment("attachments/x.png");
    expect(heard).toEqual(["attachments/x.png", "attachments/x.png"]);
    a();
    a(); // a second release of the same claim changes nothing
    expect(isAttachmentWanted("attachments/x.png")).toBe(true);
    b();
    expect(isAttachmentWanted("attachments/x.png")).toBe(false);
    off();
    wantAttachment("attachments/y.png")();
    expect(heard).toHaveLength(2);
  });
});
