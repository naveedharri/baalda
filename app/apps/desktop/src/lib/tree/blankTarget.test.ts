import { describe, expect, it } from "vitest";
import { isBlankTreeTarget } from "./blankTarget";

/**
 * A stand-in for a DOM node plus its ancestors, innermost first.
 *
 * Vitest runs in the node environment here (no jsdom), and the helper only ever
 * calls `closest`, so the honest cheap fake is one that walks the chain and
 * matches the class selectors in the list.
 */
function fakeEl(chain: string[][]): Element {
  const closest = (selector: string): Element | null => {
    const wanted = selector.split(",").map((s) => s.trim().replace(/^\./, ""));
    for (let i = 0; i < chain.length; i++) {
      if (chain[i].some((c) => wanted.includes(c))) return fakeEl(chain.slice(i));
    }
    return null;
  };
  return { closest } as unknown as Element;
}

describe("isBlankTreeTarget", () => {
  it("is false for no target at all", () => {
    expect(isBlankTreeTarget(null)).toBe(false);
  });

  it("is true for the tree container itself", () => {
    expect(isBlankTreeTarget(fakeEl([["filetree"]]))).toBe(true);
  });

  it("is true for the empty-vault placeholder", () => {
    // The case a root menu exists for: no rows, so no row handler can fire.
    expect(isBlankTreeTarget(fakeEl([["filetree-empty"], ["filetree"]]))).toBe(
      true,
    );
  });

  it("is true for the gap between rows", () => {
    // Arborist's row slot is taller than the `.tree-row` inside it, so the
    // strip between two rows really is blank space.
    expect(
      isBlankTreeTarget(
        fakeEl([["tree-rowwrap"], ["filetree-scroll"], ["filetree"]]),
      ),
    ).toBe(true);
  });

  it("is false on a row, and on anything inside one", () => {
    expect(isBlankTreeTarget(fakeEl([["tree-row", "is-dir"]]))).toBe(false);
    expect(
      isBlankTreeTarget(
        fakeEl([["tree-label"], ["tree-row"], ["tree-rowwrap"], ["filetree"]]),
      ),
    ).toBe(false);
  });

  it("is false on the toolbars", () => {
    expect(
      isBlankTreeTarget(
        fakeEl([["tree-tool"], ["filetree-actions"], ["filetree-head"]]),
      ),
    ).toBe(false);
    expect(isBlankTreeTarget(fakeEl([["filetree-selectbar"]]))).toBe(false);
  });

  it("is false inside an already-open menu", () => {
    expect(
      isBlankTreeTarget(fakeEl([["menu-heading"], ["context-menu"]])),
    ).toBe(false);
    expect(
      isBlankTreeTarget(fakeEl([["context-menu", "tree-sort-menu"]])),
    ).toBe(false);
  });

  it("is false inside a dialog the tree renders", () => {
    // ShareDialog is a DOM child of `.filetree`, not a portal.
    expect(
      isBlankTreeTarget(
        fakeEl([["modal", "share-dialog"], ["modal-backdrop"], ["filetree"]]),
      ),
    ).toBe(false);
  });
});
