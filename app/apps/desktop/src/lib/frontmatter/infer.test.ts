import { describe, expect, it } from "vitest";
import { coerceValue, inferType, isFixedType, isListType } from "./infer";
import type { PropValue } from "./parse";

describe("inferType", () => {
  const table: Array<[string, PropValue, string]> = [
    ["tags", { kind: "list", value: ["a"] }, "tags"],
    // Name beats shape: a `tags: youtube` string is still the tags property.
    ["tags", { kind: "text", value: "youtube" }, "tags"],
    ["aliases", { kind: "list", value: [] }, "aliases"],
    ["topics", { kind: "list", value: ["a"] }, "list"],
    ["done", { kind: "checkbox", value: false }, "checkbox"],
    ["count", { kind: "number", value: 2 }, "number"],
    ["due", { kind: "date", value: "2026-09-11" }, "date"],
    ["at", { kind: "datetime", value: "2026-09-11T08:00:00Z" }, "datetime"],
    ["status", { kind: "text", value: "draft" }, "text"],
    ["status", { kind: "text", value: "" }, "text"],
  ];
  for (const [key, value, expected] of table) {
    it(`${key} (${value.kind}) → ${expected}`, () => {
      expect(inferType(key, value)).toBe(expected);
    });
  }

  it("pins `tags` so the Rust tag index cannot be broken from the UI", () => {
    expect(isFixedType("tags")).toBe(true);
    expect(isFixedType("Tags")).toBe(true);
    expect(isFixedType("aliases")).toBe(false);
  });

  it("knows which types render as chips", () => {
    expect([isListType("list"), isListType("tags"), isListType("aliases")]).toEqual([
      true,
      true,
      true,
    ]);
    expect(isListType("text")).toBe(false);
  });
});

describe("coerceValue", () => {
  it("keeps the text it cannot represent", () => {
    expect(coerceValue({ kind: "text", value: "a, b" }, "list")).toEqual({
      kind: "list",
      value: ["a", "b"],
    });
    expect(coerceValue({ kind: "list", value: ["a", "b"] }, "text")).toEqual({
      kind: "text",
      value: "a, b",
    });
    expect(coerceValue({ kind: "text", value: "nope" }, "number")).toEqual({
      kind: "text",
      value: "nope",
    });
    expect(coerceValue({ kind: "text", value: "12" }, "number")).toEqual({
      kind: "number",
      value: 12,
    });
    expect(coerceValue({ kind: "text", value: "" }, "list")).toEqual({
      kind: "list",
      value: [],
    });
    expect(
      coerceValue({ kind: "datetime", value: "2026-09-11T08:00:00Z" }, "date"),
    ).toEqual({ kind: "date", value: "2026-09-11" });
  });
});
