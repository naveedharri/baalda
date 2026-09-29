import { beforeEach, describe, expect, it } from "vitest";
import {
  clampEditorFontSize,
  EDITOR_FONT_SIZE_DEFAULT,
  EDITOR_FONT_SIZE_MAX,
  EDITOR_FONT_SIZE_MIN,
  readEditorFontSize,
  writeEditorFontSize,
} from "../prefs";
import {
  clampZoom,
  ZOOM_MAX,
  ZOOM_MIN,
  zoomAt,
  zoomFromWheel,
  zoomIn,
  zoomKeyAction,
  zoomOut,
} from "../imageZoom";

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
});

describe("editor font size pref", () => {
  it("defaults to 16px (the old --fs-lg) when unset or blank", () => {
    expect(EDITOR_FONT_SIZE_DEFAULT).toBe(16);
    expect(readEditorFontSize()).toBe(16);
    store.set("context.editorFontSize", " ");
    expect(readEditorFontSize()).toBe(16);
  });
  it("clamps, rounds, and survives garbage", () => {
    expect(clampEditorFontSize(4)).toBe(EDITOR_FONT_SIZE_MIN);
    expect(clampEditorFontSize(99)).toBe(EDITOR_FONT_SIZE_MAX);
    expect(clampEditorFontSize(17.6)).toBe(18);
    expect(clampEditorFontSize(Number.NaN)).toBe(16);
    expect(clampEditorFontSize(Infinity)).toBe(EDITOR_FONT_SIZE_MAX);
    store.set("context.editorFontSize", "abc");
    expect(readEditorFontSize()).toBe(16);
  });
  it("round-trips through storage", () => {
    writeEditorFontSize(20);
    expect(readEditorFontSize()).toBe(20);
    writeEditorFontSize(100);
    expect(readEditorFontSize()).toBe(EDITOR_FONT_SIZE_MAX);
  });
});

describe("image zoom math", () => {
  it("clamps and steps symmetrically", () => {
    expect(clampZoom(0)).toBe(ZOOM_MIN);
    expect(clampZoom(1e9)).toBe(ZOOM_MAX);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(zoomOut(zoomIn(1))).toBeCloseTo(1);
    expect(zoomFromWheel(zoomFromWheel(1, 100), -100)).toBeCloseTo(1);
    expect(zoomFromWheel(1, -100)).toBeGreaterThan(1);
  });
  it("keeps the point under the cursor fixed", () => {
    const v = { zoom: 1, x: 10, y: -5 };
    const next = zoomAt(v, 2, 120, 40);
    expect((120 - next.x) / next.zoom).toBeCloseTo((120 - v.x) / v.zoom);
    expect((40 - next.y) / next.zoom).toBeCloseTo((40 - v.y) / v.zoom);
  });
  it("maps Cmd/Ctrl + = - 0 keys", () => {
    expect(zoomKeyAction({ key: "=", metaKey: true, ctrlKey: false })).toBe("in");
    expect(zoomKeyAction({ key: "-", metaKey: false, ctrlKey: true })).toBe("out");
    expect(zoomKeyAction({ key: "0", metaKey: true, ctrlKey: false })).toBe("reset");
    expect(zoomKeyAction({ key: "=", metaKey: false, ctrlKey: false })).toBeNull();
    expect(zoomKeyAction({ key: "a", metaKey: true, ctrlKey: false })).toBeNull();
  });
});
