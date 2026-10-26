import { describe, expect, it } from "vitest";
import {
  base64ToText,
  bundleSha256,
  caseDuplicate,
  checkSkillCaps,
  isValidSkillName,
  isValidSkillPath,
  parseSkillFrontmatter,
  sha256OfBase64,
  skillNameNeedsWarning,
  skillPathProblem,
  suggestSkillName,
  textToBase64,
  validateSkillMd,
  limitProblemText,
} from "../validate";

describe("names", () => {
  it("accepts valid names", () => {
    for (const n of ["a", "my-skill", "a1-b2", "a".repeat(64), "comx", "con-tool"]) {
      expect(isValidSkillName(n), n).toBe(true);
    }
  });

  it("refuses invalid names", () => {
    for (const n of ["", "a".repeat(65), "-a", "a-", "a--b", "A", "a_b", "con", "COM1", "com1", "lpt9"]) {
      expect(isValidSkillName(n), n).toBe(false);
    }
  });

  it("warns for claude/anthropic", () => {
    expect(skillNameNeedsWarning("my-claude-helper")).toBe(true);
    expect(skillNameNeedsWarning("Anthropic-tools")).toBe(true);
    expect(skillNameNeedsWarning("deploy")).toBe(false);
  });

  it("suggests a name", () => {
    expect(suggestSkillName("My Cool_Skill (v2)")).toBe("my-cool-skill-v2");
    expect(suggestSkillName("--x--")).toBe("x");
  });
});

describe("paths", () => {
  it("accepts valid paths", () => {
    expect(isValidSkillPath("SKILL.md")).toBe(true);
    expect(isValidSkillPath("scripts/run.sh")).toBe(true);
    expect(skillPathProblem("SKILL.md")).toBeNull();
  });

  it("refuses bad paths", () => {
    const bad = [
      "", "/abs", "a/../b", "./a", "a//b", "a\\b", "a:b", "a?b", ".env", "dir/.hidden",
      "trail.", "trail ", "con.txt", "dir/aux", "a".repeat(241), `d/${"b".repeat(101)}`, "a\u0001b",
    ];
    for (const p of bad) expect(isValidSkillPath(p), JSON.stringify(p)).toBe(false);
  });

  it("allows 240 chars and a 100-char component", () => {
    expect(isValidSkillPath(`${"a".repeat(100)}/${"b".repeat(100)}/${"c".repeat(38)}`)).toBe(true);
  });

  it("caseDuplicate finds the colliding path", () => {
    expect(caseDuplicate(["SKILL.md", "skill.md"])).toBe("skill.md");
    expect(caseDuplicate(["a", "b"])).toBeNull();
  });
});

describe("caps", () => {
  const MB = 1_048_576;
  it("passes within the limits", () => {
    expect(checkSkillCaps(Array.from({ length: 5 }, () => ({ size: 5 * MB })))).toBeNull();
    expect(checkSkillCaps(Array.from({ length: 1000 }, () => ({ size: 1 })))).toBeNull();
  });
  it("too many files", () => {
    expect(checkSkillCaps(Array.from({ length: 1001 }, () => ({ size: 1 })))).toBe("skill_too_many_files");
  });
  it("file too large", () => {
    expect(checkSkillCaps([{ size: 5 * MB + 1 }])).toBe("skill_file_too_large");
  });
  it("total too large", () => {
    const files = Array.from({ length: 5 }, () => ({ size: 5 * MB }));
    expect(checkSkillCaps([...files, { size: 1 }])).toBe("skill_too_large");
  });
});

describe("frontmatter", () => {
  const fm = (body: string) => `---\n${body}\n---\n# body\n`;

  it("parses simple values", () => {
    expect(parseSkillFrontmatter(fm("name: a\ndescription: Does a thing"))).toEqual({
      ok: true, name: "a", description: "Does a thing",
    });
  });

  it("parses quoted values", () => {
    expect(parseSkillFrontmatter(fm(`name: "a"\ndescription: 'It''s: fine'`))).toEqual({
      ok: true, name: "a", description: "It's: fine",
    });
  });

  it("parses folded and literal blocks", () => {
    expect(parseSkillFrontmatter(fm("name: a\ndescription: >\n  line one\n  line two"))).toEqual({
      ok: true, name: "a", description: "line one line two",
    });
    expect(parseSkillFrontmatter(fm("name: a\ndescription: |\n  line one\n  line two"))).toEqual({
      ok: true, name: "a", description: "line one\nline two",
    });
  });

  it("joins a description continued on an indented line", () => {
    expect(parseSkillFrontmatter(fm("name: a\ndescription: first\n  second"))).toEqual({
      ok: true, name: "a", description: "first second",
    });
  });

  it("ignores extra keys including nested mapping and list", () => {
    const r = parseSkillFrontmatter(
      fm("name: a\ndescription: d\nmetadata:\n  author: me\n  v: 1\ntags:\n  - x\n  - y\nlicense: MIT"),
    );
    expect(r).toEqual({ ok: true, name: "a", description: "d" });
  });

  it("accepts CRLF", () => {
    expect(parseSkillFrontmatter("---\r\nname: a\r\ndescription: d\r\n---\r\nbody")).toEqual({
      ok: true, name: "a", description: "d",
    });
  });

  it("refusals", () => {
    expect(parseSkillFrontmatter("# no fm")).toEqual({ ok: false, reason: "no_frontmatter" });
    expect(parseSkillFrontmatter("---\nname: a\ndescription: d\n")).toEqual({ ok: false, reason: "no_frontmatter" });
    expect(parseSkillFrontmatter(fm("name: a\ndescription: Use when: foo"))).toEqual({ ok: false, reason: "bad_yaml" });
    expect(parseSkillFrontmatter(fm("name: a\nname: b\ndescription: d"))).toEqual({ ok: false, reason: "bad_yaml" });
    expect(parseSkillFrontmatter(fm("name: a"))).toEqual({ ok: false, reason: "description" });
    expect(parseSkillFrontmatter(fm(`name: a\ndescription: ${"x".repeat(1025)}`))).toEqual({ ok: false, reason: "description" });
    expect(parseSkillFrontmatter(fm("name: 123\ndescription: d"))).toEqual({ ok: false, reason: "name_mismatch" });
  });

  it("accepts a 1024-char description", () => {
    expect(parseSkillFrontmatter(fm(`name: a\ndescription: ${"x".repeat(1024)}`)).ok).toBe(true);
  });

  it("validateSkillMd", () => {
    expect(validateSkillMd(null, "a")).toBe("missing_skill_md");
    expect(validateSkillMd(fm("name: a\ndescription: d"), "a")).toBeNull();
    expect(validateSkillMd(fm("name: b\ndescription: d"), "a")).toBe("name_mismatch");
  });
});

describe("hashes and base64", () => {
  const md = "---\nname: a\ndescription: b\n---\n";

  it("matches the known vectors", async () => {
    const sha = await sha256OfBase64(textToBase64(md));
    expect(sha).toBe("a98e4e3c6591006048de00b4ec52ad408c39cbaf09f591f4f620ea6a17cbfe3e");
    const bundle = await bundleSha256([{ path: "SKILL.md", sha256: sha, executable: false }]);
    expect(bundle).toBe("e31c3545cce6aa9d32d280b0348168b086082496410f08b32c7b2b5f0bb434b6");
  });

  it("is order independent and sensitive to the executable flag", async () => {
    const a = { path: "SKILL.md", sha256: "aa", executable: false };
    const b = { path: "scripts/run.sh", sha256: "bb", executable: false };
    expect(await bundleSha256([a, b])).toBe(await bundleSha256([b, a]));
    expect(await bundleSha256([a, b])).not.toBe(await bundleSha256([a, { ...b, executable: true }]));
  });

  it("round-trips non-ASCII text", () => {
    const t = "héllo wörld — 日本語 🚀";
    expect(base64ToText(textToBase64(t))).toBe(t);
  });

  it("returns null for invalid UTF-8", () => {
    expect(base64ToText(btoa("\xff\xfe\xfd"))).toBeNull();
  });
});

describe("limitProblemText", () => {
  it("turns server codes and Rust reader messages into plain words", () => {
    expect(limitProblemText("too many files (max 1000)")).toBe(
      "it has more than 1000 files. Remove build or media folders and try again.",
    );
    expect(limitProblemText("skill_too_many_files")).toMatch(/more than 1000 files/);
    expect(limitProblemText("file too large: media/demo.mp4 (max 5 MiB)")).toBe(
      "media/demo.mp4 is over 5 MB. Remove it or make it smaller and try again.",
    );
    expect(limitProblemText("skill too large (max 25 MiB)")).toMatch(/over 25 MB in total/);
    expect(limitProblemText("symlinks are not allowed: x")).toBeNull();
  });
});
