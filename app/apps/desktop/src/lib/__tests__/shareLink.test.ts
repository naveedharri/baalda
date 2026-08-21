import { describe, expect, it } from "vitest";
import { buildNoteLink, parseNoteLink, SHARE_SCHEME } from "../shareLink";

/**
 * The link format is a wire contract between two installs of the app, one of
 * which may be an older release. These tests pin the shape, and — more
 * importantly — pin that a hostile or malformed URL is a quiet `null` rather
 * than a throw, because anything on the machine can hand us one.
 */
describe("share links", () => {
  it("round-trips a vault + note id", () => {
    const target = { orgId: "org_123", docId: "d0c-4bcd" };
    const link = buildNoteLink(target);
    expect(link).toBe(`${SHARE_SCHEME}://note/org_123/d0c-4bcd`);
    expect(parseNoteLink(link)).toEqual(target);
  });

  it("round-trips ids that need escaping", () => {
    const target = { orgId: "org/with slash", docId: "doc#hash?q" };
    expect(parseNoteLink(buildNoteLink(target))).toEqual(target);
  });

  it("accepts the host-folded form some platforms deliver", () => {
    // Depending on how the OS hands the URL over, "note" can land as the host
    // or as the first path segment. Both have to parse, or links work on one
    // platform and silently do nothing on another.
    expect(parseNoteLink("baalda:///note/org_1/doc_1")).toEqual({
      orgId: "org_1",
      docId: "doc_1",
    });
  });

  it("rejects anything that isn't one of ours", () => {
    for (const url of [
      "https://example.com/note/org/doc",
      "baalda://vault/org_1",
      "baalda://note/org_1", // no doc id
      "baalda://note", // no ids at all
      "not a url at all",
      "",
    ]) {
      expect(parseNoteLink(url)).toBeNull();
    }
  });

  it("carries ids only — never a path, a token, or content", () => {
    const link = buildNoteLink({ orgId: "org_1", docId: "doc_1" });
    expect(link).not.toMatch(/\.md/);
    expect(link).not.toMatch(/token|secret|key/i);
  });
});
