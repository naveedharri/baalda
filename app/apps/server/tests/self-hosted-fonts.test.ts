import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { FONT_FACE_CSS } from "../src/http/fonts.js";
import { page } from "../src/http/pages.js";
import { testAppDeps } from "./helpers/app.js";
import { pool } from "../src/db/pool.js";

const app = createApp(testAppDeps());

describe("self-hosted fonts", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("serves every @font-face file as cached woff2", async () => {
    const urls = [...FONT_FACE_CSS.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1]!);
    expect(urls.length).toBe(6);
    for (const url of urls) {
      const res = await app.request(url);
      expect(res.status, url).toBe(200);
      expect(res.headers.get("content-type")).toBe("font/woff2");
      expect(res.headers.get("cache-control")).toContain("max-age=31536000");
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("wOF2");
    }
  });

  it("refuses files outside the allow-list", async () => {
    expect((await app.request("/assets/fonts/..%2Fpackage.json")).status).toBe(404);
    expect((await app.request("/assets/fonts/inter-cyrillic-wght-normal.woff2")).status).toBe(404);
  });

  it("pages never reference Google Fonts", () => {
    const html = page({ title: "t", body: "b" });
    expect(html).not.toMatch(/googleapis|gstatic/);
    expect(html).toContain("@font-face");
  });
});
