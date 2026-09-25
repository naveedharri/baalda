// The folder-missing UI (#228): the banner, the Settings → Vaults row and the
// Reset local copy confirm. Rendered to static markup, like the other notices.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  ResetLocalCopyDialog,
  VaultFolderMissingBannerView,
  VaultFolderMissingRowActions,
  folderMissingActions,
  resetLocalCopyCopy,
} from "../VaultFolderMissing";
import { sidebarPathLabel } from "../SidebarHeader";

const banner = (synced: boolean) =>
  renderToStaticMarkup(
    createElement(VaultFolderMissingBannerView, {
      show: true,
      synced,
      onRestore: vi.fn(),
      onLocate: vi.fn(),
      onSwitch: vi.fn(),
    }),
  );

describe("the folder-missing banner", () => {
  it("offers Restore here, Locate folder… and Switch vault for a synced vault", () => {
    const html = banner(true);
    expect(html).toContain("This vault&#x27;s folder is missing.");
    expect(html).toContain("It was moved, renamed or deleted.");
    expect(html).toContain("Restore here");
    expect(html).toContain("Locate folder…");
    expect(html).toContain("Switch vault");
    expect(html).not.toContain("Reopen vault");
    // Restore here leads.
    expect(html.indexOf("Restore here")).toBeLessThan(html.indexOf("Locate folder…"));
  });

  it("omits Restore here for a local-only vault", () => {
    const html = banner(false);
    expect(html).not.toContain("Restore here");
    expect(html).toContain("Locate folder…");
    expect(html).toContain("Switch vault");
  });

  it("renders nothing while the folder is present", () => {
    const html = renderToStaticMarkup(
      createElement(VaultFolderMissingBannerView, {
        show: false,
        synced: true,
        onRestore: vi.fn(),
        onLocate: vi.fn(),
        onSwitch: vi.fn(),
      }),
    );
    expect(html).toBe("");
  });

  it("names the actions per vault kind", () => {
    expect(folderMissingActions(true)).toEqual(["restore", "locate"]);
    expect(folderMissingActions(false)).toEqual(["locate"]);
  });
});

describe("the Settings → Vaults row", () => {
  it("shows a Folder missing badge instead of Current, with the same actions", () => {
    const html = renderToStaticMarkup(
      createElement(VaultFolderMissingRowActions, {
        synced: true,
        onRestore: vi.fn(),
        onLocate: vi.fn(),
      }),
    );
    expect(html).toContain("Folder missing");
    expect(html).not.toContain("Current");
    expect(html).toContain("Restore here");
    expect(html).toContain("Locate folder…");
  });

  it("offers only Locate folder… on a local vault's row", () => {
    const html = renderToStaticMarkup(
      createElement(VaultFolderMissingRowActions, {
        synced: false,
        onRestore: vi.fn(),
        onLocate: vi.fn(),
      }),
    );
    expect(html).toContain("Folder missing");
    expect(html).not.toContain("Restore here");
    expect(html).toContain("Locate folder…");
  });
});

describe("the sidebar header path line", () => {
  it("says Folder missing instead of the path", () => {
    expect(sidebarPathLabel("/Users/ann/Documents/a", { switching: false, rootMissing: true })).toBe(
      "Folder missing",
    );
    expect(sidebarPathLabel("/Users/ann/Documents/a", { switching: false, rootMissing: false })).toBe(
      "/Documents/a",
    );
  });
});

describe("the Reset local copy confirm", () => {
  it("says Reset when everything is on the server", () => {
    const copy = resetLocalCopyCopy([]);
    expect(copy.title).toBe("Reset this vault on this device?");
    expect(copy.body).toBe(
      "Baalda permanently deletes this vault's folder on this device and downloads a fresh copy from the Remote Vault. Nothing changes for your team.",
    );
    expect(copy.warning).toBeNull();
    expect(copy.confirmLabel).toBe("Reset");
    const html = renderToStaticMarkup(
      createElement(ResetLocalCopyDialog, { unsynced: [], onConfirm: vi.fn(), onCancel: vi.fn() }),
    );
    expect(html).toContain("Reset this vault on this device?");
    expect(html).toContain("permanently deletes");
    expect(html).not.toContain("will be lost");
  });

  it("names unsynced notes and says Delete and reset", () => {
    const paths = ["a.md", "b.md", "c.md", "d.md", "e.md", "f.md", "g.md"];
    const copy = resetLocalCopyCopy(paths);
    expect(copy.warning).toBe("7 notes have changes that haven't reached the server. They will be lost.");
    expect(copy.confirmLabel).toBe("Delete and reset");
    expect(copy.shown).toEqual(paths.slice(0, 5));
    expect(copy.more).toBe(2);
    const html = renderToStaticMarkup(
      createElement(ResetLocalCopyDialog, { unsynced: paths, onConfirm: vi.fn(), onCancel: vi.fn() }),
    );
    expect(html).toContain("They will be lost.");
    expect(html).toContain("a.md");
    expect(html).not.toContain("f.md");
    expect(html).toContain("and 2 more");
    expect(html).toContain("Delete and reset");
  });

  it("uses the singular for one note", () => {
    expect(resetLocalCopyCopy(["a.md"]).warning).toBe(
      "1 note has changes that haven't reached the server. They will be lost.",
    );
  });
});
