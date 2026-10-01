import { describe, expect, it } from "vitest";
import {
  BLANK_INGEST_MIN_CHARS,
  isBlankTruncation,
  meaningfulLength,
  noteBody,
} from "../blankFile";

// The pure rule behind the widened ingest truncation guard (#256).
describe("noteBody", () => {
  it("strips a closed leading frontmatter block", () => {
    expect(noteBody("---\ntitle: x\n---\nhello\n")).toBe("hello\n");
    expect(noteBody("---\r\ntitle: x\r\n...\r\nhello")).toBe("hello");
    expect(noteBody("---\n---\n")).toBe("");
    expect(noteBody("﻿---\na: 1\n---")).toBe("");
  });

  it("leaves text without a closed block alone", () => {
    expect(noteBody("---\ntitle: never closed\nhello")).toBe("---\ntitle: never closed\nhello");
    expect(noteBody("hello\n---\nworld\n---\n")).toBe("hello\n---\nworld\n---\n");
  });
});

describe("isBlankTruncation", () => {
  const big = "x".repeat(BLANK_INGEST_MIN_CHARS);

  it("refuses a blank or frontmatter-only file over a populated doc", () => {
    expect(isBlankTruncation(big, "\n")).toBe(true);
    expect(isBlankTruncation(big, " \t\n\n")).toBe(true);
    expect(isBlankTruncation(`---\na: 1\n---\n${big}`, "---\na: 1\n---\n")).toBe(true);
  });

  it("never refuses a file that keeps any body text", () => {
    expect(isBlankTruncation(big, "x")).toBe(false);
    expect(isBlankTruncation(big, "---\na: 1\n---\n# Title\n")).toBe(false);
  });

  it("lets a short note be cleared — the server's 200-character floor", () => {
    expect(isBlankTruncation("x".repeat(BLANK_INGEST_MIN_CHARS - 1), "\n")).toBe(false);
    // Frontmatter does not count toward the floor: only the body is content.
    expect(meaningfulLength(`---\nnote: ${big}\n---\nhi`)).toBe(2);
    expect(isBlankTruncation(`---\nnote: ${big}\n---\nhi`, "---\nnote: x\n---\n")).toBe(false);
  });
});
