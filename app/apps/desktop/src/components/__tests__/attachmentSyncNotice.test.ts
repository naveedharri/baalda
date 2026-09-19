// SPDX-License-Identifier: Apache-2.0

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  AttachmentLocalOnlyNoticeView,
  attachmentNoticeVisible,
} from "../AttachmentSyncNotice";

describe("AttachmentLocalOnlyNoticeView", () => {
  it("requires both a server refusal and a detected local attachment", () => {
    expect(attachmentNoticeVisible(true, true)).toBe(true);
    expect(attachmentNoticeVisible(true, false)).toBe(false);
    expect(attachmentNoticeVisible(false, true)).toBe(false);
  });
  it("explains that files remain previewable while notes keep syncing", () => {
    const html = renderToStaticMarkup(
      createElement(AttachmentLocalOnlyNoticeView, {
        show: true,
        showUpgrade: true,
        onUpgrade: vi.fn(),
        onOpenHealth: vi.fn(),
      }),
    );

    expect(html).toContain("Attachment sync requires Pro");
    expect(html).toContain("Notes still sync");
    expect(html).toContain("remain available to preview locally");
    expect(html).toContain("Upgrade to Pro");
    expect(html).toContain("Open Health");
  });

  it("does not offer managed billing when the server has billing disabled", () => {
    const html = renderToStaticMarkup(
      createElement(AttachmentLocalOnlyNoticeView, {
        show: true,
        showUpgrade: false,
        onUpgrade: vi.fn(),
        surface: "health",
      }),
    );

    expect(html).toContain("Attachment sync requires Pro");
    expect(html).not.toContain("Upgrade");
  });

  it("renders nothing until the server explicitly refuses attachment sync", () => {
    const html = renderToStaticMarkup(
      createElement(AttachmentLocalOnlyNoticeView, {
        show: false,
        showUpgrade: true,
        onUpgrade: vi.fn(),
      }),
    );

    expect(html).toBe("");
  });
});
