// SPDX-License-Identifier: Apache-2.0

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AttachmentLocalOnlyNoticeView } from "../AttachmentSyncNotice";

describe("AttachmentLocalOnlyNoticeView", () => {
  it("explains that files remain previewable while notes keep syncing", () => {
    const html = renderToStaticMarkup(
      createElement(AttachmentLocalOnlyNoticeView, {
        show: true,
        showUpgrade: true,
        onUpgrade: vi.fn(),
        onOpenHealth: vi.fn(),
      }),
    );

    expect(html).toContain("Attachments are local only in this vault");
    expect(html).toContain("Notes still sync");
    expect(html).toContain("preview every supported file on this device");
    expect(html).toContain("Upgrade to sync attachments");
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

    expect(html).toContain("Attachments are local only in this vault");
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
