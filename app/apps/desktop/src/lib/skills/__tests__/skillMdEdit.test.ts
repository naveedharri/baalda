import { describe, expect, it } from "vitest";
import { readSkillHeader, setFrontmatterDescription, splitSkillMd, yamlScalar } from "../skillMdEdit";
import { parseSkillFrontmatter, readFrontmatterFields } from "../validate";

const FM = "---\nname: demo\ndescription: Old words.\nlicense: MIT\n# a comment\n---\n";

describe("splitSkillMd", () => {
  it("splits at the closing line and joins back losslessly", () => {
    const text = `${FM}\n# Demo\nbody\n`;
    const parts = splitSkillMd(text)!;
    expect(parts.frontmatter).toBe(FM);
    expect(parts.frontmatter + parts.body).toBe(text);
  });
  it("needs an opening and a closing line", () => {
    expect(splitSkillMd("# no frontmatter")).toBeNull();
    expect(splitSkillMd("---\nname: x\n")).toBeNull();
  });
  it("keeps CRLF and a BOM", () => {
    const text = "﻿---\r\nname: a\r\n---\r\nbody";
    expect(splitSkillMd(text)).toEqual({ frontmatter: "﻿---\r\nname: a\r\n---\r\n", body: "body" });
  });
});

describe("readSkillHeader", () => {
  it("reads name and description, even an empty or long one", () => {
    expect(readSkillHeader(`${FM}body`)).toMatchObject({ name: "demo", description: "Old words." });
    expect(readSkillHeader("---\nname: demo\n---\n")).toMatchObject({ name: "demo", description: null });
    const long = "x".repeat(1500);
    expect(readSkillHeader(`---\nname: demo\ndescription: ${long}\n---\n`)?.description).toBe(long);
  });
  it("is null when the block can't be read, so the editor shows it raw", () => {
    expect(readSkillHeader("---\nname: demo\nname: dup\n---\n")).toBeNull();
    expect(readSkillHeader("no frontmatter")).toBeNull();
  });
});

describe("yamlScalar", () => {
  const roundTrip = (v: string) => {
    const r = readFrontmatterFields(`---\nname: a\ndescription: ${yamlScalar(v)}\n---\n`);
    return "reason" in r ? r : r.description;
  };
  it("writes plain when safe and quotes when not, always reading back the same", () => {
    expect(yamlScalar("Use when testing.")).toBe("Use when testing.");
    for (const v of ["Use when: testing", "#hash first", "true", "123", "trailing ", "a # b", "- dash"]) {
      expect(yamlScalar(v)).toMatch(/^"/);
      expect(roundTrip(v)).toBe(v);
    }
    // Quotes inside a plain scalar are fine in YAML.
    expect(roundTrip('it\'s "q"')).toBe('it\'s "q"');
  });
  it("uses a literal block for multi-line text", () => {
    expect(yamlScalar("one\ntwo")).toBe("|-\n  one\n  two");
    expect(roundTrip("one\ntwo")).toBe("one\ntwo");
  });
});

describe("setFrontmatterDescription", () => {
  it("replaces only the description line, keeping other keys and comments", () => {
    expect(setFrontmatterDescription(FM, "New words.")).toBe(
      "---\nname: demo\ndescription: New words.\nlicense: MIT\n# a comment\n---\n",
    );
  });
  it("replaces a whole folded block and its continuation lines", () => {
    const fm = "---\nname: demo\ndescription: >-\n  line one\n  line two\n\nmetadata:\n  k: v\n---\n";
    const next = setFrontmatterDescription(fm, "Short.")!;
    expect(next).toBe("---\nname: demo\ndescription: Short.\n\nmetadata:\n  k: v\n---\n");
    expect(parseSkillFrontmatter(next)).toEqual({ ok: true, name: "demo", description: "Short." });
  });
  it("inserts after name when there is no description", () => {
    expect(setFrontmatterDescription("---\nname: demo\nlicense: MIT\n---\n", "Hi there")).toBe(
      "---\nname: demo\ndescription: Hi there\nlicense: MIT\n---\n",
    );
    expect(setFrontmatterDescription("---\nlicense: MIT\n---\n", "Hi")).toBe("---\nlicense: MIT\ndescription: Hi\n---\n");
  });
  it("keeps CRLF line endings", () => {
    expect(setFrontmatterDescription("---\r\nname: a\r\ndescription: b\r\n---\r\n", "c")).toBe(
      "---\r\nname: a\r\ndescription: c\r\n---\r\n",
    );
  });
  it("refuses a block it can't read", () => {
    expect(setFrontmatterDescription("---\n  bad\n---\n", "x")).toBeNull();
  });
});
