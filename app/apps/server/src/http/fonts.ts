import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Hono } from "hono";

/**
 * Self-hosted web fonts for the server's own HTML pages (public note links,
 * account pages). Served from this origin so a page view never calls a third
 * party, and the CSP can stay `font-src 'self'`.
 *
 * Files come from the `@fontsource-variable/*` packages (SIL OFL 1.1): one
 * variable woff2 per family and subset, Latin + Latin Extended only; other
 * scripts fall back to the system font stack.
 */
const require = createRequire(import.meta.url);

const FAMILIES = [
  { family: "Inter", pkg: "inter", weight: "100 900" },
  { family: "JetBrains Mono", pkg: "jetbrains-mono", weight: "100 800" },
  { family: "Radio Canada Big", pkg: "radio-canada-big", weight: "400 700" },
] as const;

const SUBSETS = [
  {
    name: "latin-ext",
    range:
      "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
  },
  {
    name: "latin",
    range:
      "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
  },
] as const;

/** Public path prefix the @font-face rules point at. */
export const FONT_PATH = "/assets/fonts";

/** file name → package specifier; the route serves only these. */
const FILES = new Map<string, string>();
for (const f of FAMILIES) {
  for (const s of SUBSETS) {
    const file = `${f.pkg}-${s.name}-wght-normal.woff2`;
    FILES.set(file, `@fontsource-variable/${f.pkg}/files/${file}`);
  }
}

/** `@font-face` rules for every self-hosted family, for inline `<style>`. */
export const FONT_FACE_CSS = FAMILIES.flatMap((f) =>
  SUBSETS.map(
    (s) =>
      `@font-face{font-family:"${f.family}";font-style:normal;font-display:swap;` +
      `font-weight:${f.weight};src:url(${FONT_PATH}/${f.pkg}-${s.name}-wght-normal.woff2) format("woff2-variations");` +
      `unicode-range:${s.range};}`,
  ),
).join("\n");

const cache = new Map<string, Uint8Array>();

async function load(file: string): Promise<Uint8Array | null> {
  const spec = FILES.get(file);
  if (!spec) return null;
  const hit = cache.get(file);
  if (hit) return hit;
  const bytes = new Uint8Array(await readFile(require.resolve(spec)));
  cache.set(file, bytes);
  return bytes;
}

/** `GET /assets/fonts/:file` — allow-listed woff2 files, cached for a year. */
export function createFontRoutes(): Hono {
  const app = new Hono();
  app.get(`${FONT_PATH}/:file`, async (c) => {
    const bytes = await load(c.req.param("file"));
    if (!bytes) return c.notFound();
    return c.body(bytes, 200, {
      "content-type": "font/woff2",
      // Package files are immutable for a given version; a font upgrade
      // ships under the same name, so a year is the ceiling, not forever.
      "cache-control": "public, max-age=31536000",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
    });
  });
  return app;
}
