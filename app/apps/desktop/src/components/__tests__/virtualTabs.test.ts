import { describe, expect, it } from "vitest";
import { compareTabId, neighbourAfterClose, textTabId, upsertTab, type VirtualTab } from "../virtualTabs";

const t = (id: string): VirtualTab => ({ kind: "review", id, title: id });

describe("virtual tabs", () => {
  it("ids are single-instance per source", () => {
    const copy = { type: "copy" as const, stamp: "s", relPath: "a.md" };
    expect(textTabId(copy)).toBe(textTabId({ ...copy }));
    expect(textTabId(copy)).not.toBe(textTabId({ type: "note", path: "a.md" }));
    expect(compareTabId(copy, { type: "note", path: "a.md" })).toBe("compare|copy:s/a.md|note:a.md");
  });

  it("upsert replaces in place and appends new", () => {
    const tabs = [t("a"), t("b")];
    expect(upsertTab(tabs, { kind: "review", id: "a", title: "A2" }).map((x) => x.title)).toEqual(["A2", "b"]);
    expect(upsertTab(tabs, t("c")).map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("closing picks the right neighbour, then left, then none", () => {
    const tabs = [t("a"), t("b"), t("c")];
    expect(neighbourAfterClose(tabs, "b")).toBe("c");
    expect(neighbourAfterClose(tabs, "c")).toBe("b");
    expect(neighbourAfterClose([t("a")], "a")).toBeNull();
    expect(neighbourAfterClose(tabs, "zz")).toBeNull();
  });
});
