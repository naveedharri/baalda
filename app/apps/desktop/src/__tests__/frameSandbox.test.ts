// Red team 3: note/dashboard frames must stay opaque-origin. `trusted_window`
// (Rust) checks the WEBVIEW's label and URL, not the calling frame, so what keeps
// a dashboard's script off `vault_secret_get` / `save_text_file` is that its
// frame never shares the app's origin (no `allow-same-origin`), its CSP allows
// no connections, and no capability grants remote IPC. Pin all three.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("frame isolation for note content", () => {
  it("no iframe in the app is given allow-same-origin or top navigation", () => {
    const dir = join(root, "src", "components");
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".tsx"))) {
      for (const m of read(`src/components/${f}`).matchAll(/sandbox="([^"]*)"/g)) {
        if (/allow-same-origin|allow-top-navigation/.test(m[1])) offenders.push(`${f}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the dashboard CSP allows no connections and is itself sandboxed", () => {
    const rs = read("src-tauri/src/dashboard.rs");
    const csp = /pub const DASHBOARD_CSP: &str = "([^"]+)"/.exec(rs)?.[1] ?? "";
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toMatch(/sandbox allow-scripts/);
    expect(csp).not.toContain("allow-same-origin");
  });

  it("no capability grants IPC to remote origins", () => {
    for (const f of readdirSync(join(root, "src-tauri", "capabilities"))) {
      const text = read(`src-tauri/capabilities/${f}`);
      expect(text, f).not.toMatch(/"remote"\s*:/);
    }
    expect(read("src-tauri/tauri.conf.json")).not.toMatch(/dangerousRemoteDomainIpcAccess/);
  });
});
