// The packaged app's Content-Security-Policy, pinned.
//
// WHY a test for a config string: Tauri injects this CSP only into PACKAGED
// builds — `pnpm dev` serves from the Vite devUrl, which has none — so a
// directive that breaks the app is invisible for the whole development cycle and
// only shows up after a release. Two real bugs lived here:
//
//   `frame-src 'none'`  blocked all three iframes we actually ship (the PDF
//                       embed widget, FilePreview's PDF pane, and HtmlView's
//                       `srcdoc` page). `'self'` is what lets a `srcdoc` frame
//                       load at all; `sandbox=""` still blocks execution inside
//                       it, so this is not a loosening of the real guard.
//   asset.localhost     Tauri 2 serves the asset protocol over
//                       `http://asset.localhost` on Windows unless
//                       `useHttpsScheme` is set, and only the `https://` form
//                       was allowed — so in-note images were broken on packaged
//                       Windows builds while working everywhere else.
//
// `object-src 'none'` and `script-src 'self'` are the parts that must NEVER
// widen: a note is untrusted input and the editor renders HTML from it.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const conf = JSON.parse(readFileSync(resolve(appRoot, "src-tauri/tauri.conf.json"), "utf8"));
const csp: string = conf.app.security.csp;

/** directive name → its source list. */
const directives = new Map<string, string[]>(
  csp
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [name, ...sources] = part.split(/\s+/);
      return [name, sources] as [string, string[]];
    }),
);

const ASSET_ORIGINS = ["asset:", "http://asset.localhost", "https://asset.localhost"];

describe("packaged CSP", () => {
  it("is a well-formed directive list", () => {
    expect(csp).toBeTypeOf("string");
    expect(directives.size).toBeGreaterThan(5);
    expect(directives.get("default-src")).toEqual(["'self'"]);
  });

  it("lets the PDF/HTML iframes load", () => {
    const frame = directives.get("frame-src");
    expect(frame).toBeDefined();
    expect(frame).toContain("'self'");
    for (const origin of ASSET_ORIGINS) expect(frame, origin).toContain(origin);
  });

  it("declares media-src so <video>/<audio> can read the asset protocol", () => {
    const media = directives.get("media-src");
    expect(media).toBeDefined();
    for (const origin of ASSET_ORIGINS) expect(media, origin).toContain(origin);
  });

  it("allows in-note images over both asset.localhost schemes", () => {
    const img = directives.get("img-src");
    expect(img).toBeDefined();
    for (const origin of ASSET_ORIGINS) expect(img, origin).toContain(origin);
  });

  it("keeps the guards that must never widen", () => {
    expect(directives.get("object-src")).toEqual(["'none'"]);
    expect(directives.get("script-src")).toEqual(["'self'"]);
    expect(directives.get("base-uri")).toEqual(["'self'"]);
  });
});
