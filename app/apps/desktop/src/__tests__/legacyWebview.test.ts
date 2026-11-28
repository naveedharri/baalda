// Older webviews: the app must start, or say why it can't.
//
// An Intel Mac reported "just a black screen". macOS 10.15 and 11 can run a
// WKWebView older than Safari 15.4, and @noble/curves (vault keys) calls
// Object.hasOwn while it LOADS, so the whole bundle stopped before React drew
// anything and the native 1.5 s reveal showed an empty window.
// public/legacy-polyfills.js fills those gaps before any module runs;
// public/boot-guard.js writes a message when the app still never draws.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "../..");
const polyfills = readFileSync(resolve(desktop, "public/legacy-polyfills.js"), "utf8");
const guard = readFileSync(resolve(desktop, "public/boot-guard.js"), "utf8");

const STRIP = [
  "delete Object.hasOwn",
  "delete Array.prototype.at",
  "delete String.prototype.at",
  "delete Object.getPrototypeOf(Int8Array.prototype).at",
  "delete Array.prototype.findLast",
  "delete Array.prototype.findLastIndex",
  "delete String.prototype.replaceAll",
  "delete globalThis.structuredClone",
].join(";");

describe("legacy polyfills", () => {
  it("fill what an older Safari lacks", () => {
    const ctx = vm.createContext({});
    vm.runInContext(STRIP, ctx);
    expect(vm.runInContext("typeof Object.hasOwn", ctx)).toBe("undefined");
    vm.runInContext(polyfills, ctx);
    const out = vm.runInContext(`[
      Object.hasOwn({ a: 1 }, "a"), Object.hasOwn({ a: 1 }, "b"),
      [1, 2, 3].at(-1), [1, 2, 3].at(5), "abc".at(-1), new Uint8Array([4, 5]).at(0),
      [1, 2, 3, 2].findLastIndex((x) => x === 2), [1, 2, 3].findLast((x) => x < 3),
      "a.b.a".replaceAll(".", "-"), "a+a".replaceAll("+", "$&$&"), "x1x".replaceAll(/x/g, "y"),
      JSON.stringify(structuredClone({ d: [1, { e: 2 }], t: new Date(0) })),
    ]`, ctx);
    expect(out).toEqual([true, false, 3, undefined, "c", 4, 3, 2, "a-b-a", "a++a", "y1y", '{"d":[1,{"e":2}],"t":"1970-01-01T00:00:00.000Z"}']);
    expect(() => vm.runInContext('"x".replaceAll(/x/, "y")', ctx)).toThrow();
  });

  it("never replace a built-in that exists", () => {
    const ctx = vm.createContext({ structuredClone });
    const before = vm.runInContext("[Object.hasOwn, Array.prototype.at, String.prototype.replaceAll, structuredClone]", ctx);
    vm.runInContext(polyfills, ctx);
    const after = vm.runInContext("[Object.hasOwn, Array.prototype.at, String.prototype.replaceAll, structuredClone]", ctx);
    after.forEach((fn: unknown, i: number) => expect(fn).toBe(before[i]));
  });

  it("let the vault key library load without Object.hasOwn", async () => {
    const O = Object as unknown as { hasOwn?: unknown };
    const original = O.hasOwn;
    delete O.hasOwn; // an older webview
    try {
      vm.runInThisContext(polyfills);
      const m = await import("@noble/curves/ed25519.js?legacy-check" as string).catch(() => import("@noble/curves/ed25519.js"));
      expect(m.x25519.getPublicKey(new Uint8Array(32).fill(7))).toHaveLength(32);
    } finally {
      Object.defineProperty(Object, "hasOwn", { value: original, writable: true, configurable: true, enumerable: false });
    }
  });

  it("are plain scripts loaded before the app's module", () => {
    const html = readFileSync(resolve(desktop, "index.html"), "utf8");
    const poly = html.indexOf('<script src="/legacy-polyfills.js"></script>');
    const boot = html.indexOf('<script src="/boot-guard.js"></script>');
    const mod = html.indexOf('<script type="module"');
    expect(poly).toBeGreaterThan(-1);
    expect(boot).toBeGreaterThan(-1);
    expect(poly).toBeLessThan(mod);
    expect(boot).toBeLessThan(mod);
    // ES5 only: these must parse on the oldest webview we support.
    for (const src of [polyfills, guard]) {
      expect(src).not.toMatch(/=>|\blet\b|\bconst\b|\`|\bclass\b|\?\.|\?\?/);
    }
  });
});

function guardWorld(platform: string) {
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const listeners: Record<string, (e: unknown) => void> = {};
  const make = (tag: string) => {
    const el: any = { tag, childNodes: [] as unknown[], style: {}, attrs: {} as Record<string, string>, textContent: "" };
    el.appendChild = (c: unknown) => { el.childNodes.push(c); return c; };
    el.setAttribute = (k: string, v: string) => { el.attrs[k] = v; };
    return el;
  };
  const root = make("div");
  const window: any = {
    addEventListener: (type: string, fn: (e: unknown) => void) => { listeners[type] = fn; },
    setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; },
  };
  const document = {
    getElementById: (id: string) => (id === "root" ? root : null),
    createElement: make,
    documentElement: { getAttribute: () => "dark" },
  };
  const ctx = vm.createContext({ window, document, navigator: { platform, userAgent: "" } });
  vm.runInContext(guard, ctx);
  const run = (upTo: number) => timers.filter((t) => t.ms <= upTo).forEach((t) => t.fn());
  const text = () => JSON.stringify(root.childNodes);
  return { root, window, listeners, run, text };
}

describe("startup guard", () => {
  it("explains a failed start on a Mac, with the error", () => {
    const w = guardWorld("MacIntel");
    w.listeners.error({ message: "TypeError: Object.hasOwn is not a function" });
    w.run(6000);
    expect(w.text()).toContain("Baalda couldn't start");
    expect(w.text()).toContain("Software Update");
    expect(w.text()).toContain("Object.hasOwn is not a function");
  });

  it("waits longer when nothing failed, and says nothing once the app drew", () => {
    const w = guardWorld("Win32");
    w.run(6000);
    expect(w.root.childNodes).toHaveLength(0);
    w.root.childNodes.push({ tag: "app" });
    w.run(15000);
    expect(w.root.childNodes).toHaveLength(1);
  });

  it("stays quiet once the app mounted, even before it drew", () => {
    const w = guardWorld("MacIntel");
    w.listeners.error({ message: "late noise" });
    w.window.__baaldaMounted = true;
    w.run(15000);
    expect(w.root.childNodes).toHaveLength(0);
  });

  it("gives other systems the reinstall advice", () => {
    const w = guardWorld("Win32");
    w.run(15000);
    expect(w.text()).toContain("baalda.com");
  });
});
