// Every stored key the Activity UI reads (review, activity log, unread state,
// panel tab) must survive whatever is in storage: malformed JSON, wrong shapes,
// values from older or newer app versions. Never throw; drop what is bad.
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadLog, parseLog, sanitizeEntry } from "../activityLog";
import { loadReadState, parseReadState } from "../activityUnread";
import { parseReview, readPersisted } from "../reviewModel";
import { readLastTab } from "../rightPanelTab";

const NOW = Date.parse("2026-09-26T12:00:00.000Z");
const GARBAGE = [
  "",
  "{",
  "null",
  "0",
  "true",
  '"str"',
  "[]",
  "{}",
  "[1,2,3]",
  '[{"id":1}]',
  '{"since":null,"read":"x"}',
  '{"items":"nope","resolved":{}}',
  '[{"id":"x","kind":"weird","path":"a","at":1}]',
  "\u0000￿",
];

describe("activity storage: garbage in, nothing thrown", () => {
  it("activity log parse", () => {
    for (const g of GARBAGE) expect(() => parseLog(g, NOW)).not.toThrow();
    for (const g of GARBAGE) expect(Array.isArray(parseLog(g, NOW))).toBe(true);
  });

  it("keeps the good entries of a mixed log and strips bad optional fields", () => {
    const raw = JSON.stringify([
      { id: "ok", kind: "failed", path: "a.md", at: NOW, paths: ["x", 3, null], docId: 9, detail: {} },
      { id: "ok", kind: "failed", path: "a.md", at: NOW - 1 },
      { id: "", kind: "failed", path: "b", at: NOW },
      { id: "nan", kind: "held", path: "", at: Number.NaN },
      { id: "v2", kind: "futureKind", path: "c", at: NOW },
      ["array"],
      "str",
    ]);
    const log = parseLog(raw, NOW);
    expect(log).toHaveLength(1);
    expect(log[0]).toEqual({ id: "ok", kind: "failed", path: "a.md", at: NOW, paths: ["x"] });
    expect(sanitizeEntry({ id: "a", kind: "access", path: "p", at: Infinity })).toBeNull();
  });

  it("read state parse", () => {
    for (const g of GARBAGE) expect(() => parseReadState(g)).not.toThrow();
    expect(parseReadState('{"since":1e999,"read":[]}')).toBeNull();
    expect(parseReadState('{"since":3,"read":[1,"a@2",{}]}')).toEqual({ since: 3, read: ["a@2"] });
  });

  it("review parse", () => {
    for (const g of GARBAGE) expect(() => parseReview(g)).not.toThrow();
  });

  it("loaders never throw even when storage itself does", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    vi.stubGlobal("localStorage", throwing);
    expect(loadLog("/v", NOW)).toEqual([]);
    expect(loadReadState("/v", NOW).read).toEqual([]);
    expect(readLastTab()).toBe("activity");
    expect(readPersisted("/v", throwing)).toBeNull();
  });

  it("the panel tab falls back on an unknown stored value", () => {
    const kv = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => kv.get(k) ?? null,
      setItem: (k: string, v: string) => kv.set(k, v),
      removeItem: (k: string) => kv.delete(k),
    });
    for (const k of ["baalda.rightPanel.tab", "rightPanelTab"]) kv.set(k, "{garbage");
    expect(readLastTab()).toBe("activity");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
