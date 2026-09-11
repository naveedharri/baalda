// The Content width preference, and in particular its MIGRATION — the one part
// of that change that can silently hand an existing user the wrong layout.
//
// `prefs` reads `localStorage` at call time, never at import time, so a plain
// object stub on `globalThis` is enough in the node environment.
import { afterEach, describe, expect, it } from "vitest";
import {
  clampEditorMeasure,
  EDITOR_MEASURE_DEFAULT,
  EDITOR_MEASURE_MAX,
  EDITOR_MEASURE_MIN,
  readEditorMeasure,
  writeEditorMeasure,
} from "../prefs";

const NEW_KEY = "context.editorMeasure";
const LEGACY_KEY = "context.readableLineLength";

/** The two methods `prefs` uses, over a plain map. */
function stubStorage(initial: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(initial));
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
  });
  return store;
}

/** A device with storage denied: every access throws. */
function stubThrowingStorage(): void {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("localStorage is not available");
    },
  });
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
});

describe("readEditorMeasure — migration from the old switch", () => {
  it("reads the old off switch as full width", () => {
    stubStorage({ [LEGACY_KEY]: "off" });
    expect(readEditorMeasure()).toBe("full");
  });

  it("reads every other legacy value as the readable measure", () => {
    for (const legacy of ["on", "", "true", "yes"]) {
      stubStorage({ [LEGACY_KEY]: legacy });
      expect(readEditorMeasure()).toBe(EDITOR_MEASURE_DEFAULT);
    }
  });

  it("defaults on a device that has never had either key", () => {
    stubStorage();
    expect(readEditorMeasure()).toBe(EDITOR_MEASURE_DEFAULT);
  });

  it("ignores the legacy key entirely once the new one exists", () => {
    // The migration must not un-set a choice the user has since made.
    stubStorage({ [LEGACY_KEY]: "off", [NEW_KEY]: "72" });
    expect(readEditorMeasure()).toBe(72);
    stubStorage({ [LEGACY_KEY]: "on", [NEW_KEY]: "full" });
    expect(readEditorMeasure()).toBe("full");
  });
});

describe("readEditorMeasure — stored values", () => {
  it("round-trips both shapes through the writer", () => {
    const store = stubStorage();
    writeEditorMeasure("full");
    expect(readEditorMeasure()).toBe("full");
    writeEditorMeasure(88);
    // The bare number, not "88ch": the `ch` belongs to the CSS, not the store.
    expect(store.get(NEW_KEY)).toBe("88");
    expect(readEditorMeasure()).toBe(88);
  });

  it("never writes the legacy key again", () => {
    const store = stubStorage({ [LEGACY_KEY]: "off" });
    writeEditorMeasure(100);
    expect(store.get(LEGACY_KEY)).toBe("off");
    expect(readEditorMeasure()).toBe(100);
  });

  it("treats a blank or unreadable stored value as corruption, not as a request", () => {
    for (const raw of ["", "   ", "abc"]) {
      stubStorage({ [NEW_KEY]: raw });
      expect(readEditorMeasure()).toBe(EDITOR_MEASURE_DEFAULT);
    }
  });

  it("clamps a stored value from outside the range", () => {
    stubStorage({ [NEW_KEY]: "9000" });
    expect(readEditorMeasure()).toBe(EDITOR_MEASURE_MAX);
    stubStorage({ [NEW_KEY]: "4" });
    expect(readEditorMeasure()).toBe(EDITOR_MEASURE_MIN);
  });

  it("falls back to the default when storage itself throws", () => {
    stubThrowingStorage();
    expect(readEditorMeasure()).toBe(EDITOR_MEASURE_DEFAULT);
    // …and a write on such a device is a no-op rather than a crash.
    expect(() => writeEditorMeasure("full")).not.toThrow();
  });
});

describe("clampEditorMeasure", () => {
  it("snaps to the step and pins to the range", () => {
    expect(clampEditorMeasure(59)).toBe(60);
    expect(clampEditorMeasure(61)).toBe(60);
    expect(clampEditorMeasure(122)).toBe(EDITOR_MEASURE_MAX);
    expect(clampEditorMeasure(-5)).toBe(EDITOR_MEASURE_MIN);
  });

  it("answers NaN with the default, and the infinities with the bounds", () => {
    expect(clampEditorMeasure(Number.NaN)).toBe(EDITOR_MEASURE_DEFAULT);
    expect(clampEditorMeasure(Number.POSITIVE_INFINITY)).toBe(EDITOR_MEASURE_MAX);
    expect(clampEditorMeasure(Number.NEGATIVE_INFINITY)).toBe(EDITOR_MEASURE_MIN);
  });
});
