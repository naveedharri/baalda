// The format lists are ONE CONTRACT across the Rust/TS boundary, the same way
// the editor's `#tag` rule and `parse.rs TAG_RE` are: Rust decides what the tree
// walk surfaces and what the watcher indexes, TS decides what opens, embeds and
// syncs. When they drift, the app lies — a file appears in the sidebar and
// nothing opens it, or a `.txt` syncs as a CRDT note the editor refuses.
//
// Nothing can import across that boundary, so this test READS the source files
// and compares the literals. A shared JSON package was considered and rejected:
// `pnpm-workspace.yaml` covers only `apps/*` and the server image is built with
// `pnpm deploy`, so a new workspace package costs more than one test file.
//
// If this fails: change the other side too, don't loosen the test.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FORMATS, NOTE_EXTS, OPT_IN_EXTS, SURFACED_EXTS } from "../formats";
import { TRANSIENT_PREFIXES, isTransientFileName } from "../pathIdentity";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "../../..");
const read = (rel: string) => readFileSync(resolve(appRoot, rel), "utf8");

/**
 * Pull the string literals out of an array initialiser, by the name the source
 * declares it with. Line comments are stripped first so a commented-out
 * extension (or a `// "pdf"` in a note) can't be counted as a member.
 */
function literals(source: string, pattern: RegExp): string[] {
  const body = source.match(pattern)?.[1];
  if (body === undefined) throw new Error(`could not find ${pattern} in the source`);
  const stripped = body.replace(/\/\/[^\n]*/g, "");
  return Array.from(stripped.matchAll(/"([^"]*)"/g), (m) => m[1]);
}

const vaultRs = read("src-tauri/src/vault.rs");
const registryTs = read("src/lib/sync/registry.ts");
const inboundTs = read("src/lib/sync/inbound.ts");
const foldersTs = read("src/lib/syncRules/folders.ts");

const rustArray = (name: string) =>
  new RegExp(`pub const ${name}:\\s*&\\[&str\\]\\s*=\\s*&\\[([\\s\\S]*?)\\];`);
const tsArray = (name: string) => new RegExp(`const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`);

describe("folder-name lockstep (#401)", () => {
  it("build folders and OS bookkeeping match Rust's vault.rs", () => {
    expect(new Set(literals(foldersTs, tsArray("BUILD_DIRS")))).toEqual(
      new Set(literals(vaultRs, rustArray("DENIED_DIRS"))),
    );
    expect(new Set(literals(foldersTs, tsArray("OS_JUNK")))).toEqual(
      new Set(literals(vaultRs, rustArray("OS_JUNK")).map((s) => s.toLowerCase())),
    );
  });
});

describe("format lockstep", () => {
  it("surfaces exactly what Rust's ALLOWED_EXTS surfaces", () => {
    const rust = literals(vaultRs, rustArray("ALLOWED_EXTS"));
    expect(rust.length).toBeGreaterThan(0);
    // Sets, not order: Rust groups by category, TS by canonical MIME.
    expect(new Set(rust)).toEqual(new Set(SURFACED_EXTS));
    expect(new Set(rust).size).toBe(rust.length); // no duplicate in the Rust list
  });

  // #401: the optional groups an owner can switch on in Vault Settings → Sync.
  it("agrees with Rust on the optional groups, which never overlap the default set", () => {
    expect(new Set(literals(vaultRs, rustArray("CODE_EXTS")))).toEqual(new Set(OPT_IN_EXTS.code));
    expect(new Set(literals(vaultRs, rustArray("EXTRA_EXTS")))).toEqual(new Set(OPT_IN_EXTS.extra));
    const surfaced = new Set(SURFACED_EXTS);
    for (const ext of [...OPT_IN_EXTS.code, ...OPT_IN_EXTS.extra]) {
      expect(surfaced.has(ext), ext).toBe(false);
      expect(NOTE_EXTS, ext).not.toContain(ext);
    }
    for (const f of FORMATS) if (f.optIn) expect(f.surface, f.exts[0]).toBe(false);
  });

  it("claims every extension in exactly one format", () => {
    const all = FORMATS.flatMap((f) => f.exts);
    expect(all.filter((e, i) => all.indexOf(e) !== i)).toEqual([]);
  });

  it("agrees with Rust on the CRDT note family", () => {
    expect(new Set(literals(vaultRs, rustArray("NOTE_EXTS")))).toEqual(new Set(NOTE_EXTS));
  });

  it("agrees with the sync layer's two NOTE_EXTS literals", () => {
    // `registry.ts` decides what `flattenTree` registers as a server note;
    // `inbound.ts` decides what a pull materialises as one. A third spelling of
    // this list is how a `.txt` ended up half-synced.
    expect(new Set(literals(registryTs, tsArray("NOTE_EXTS")))).toEqual(new Set(NOTE_EXTS));
    expect(new Set(literals(inboundTs, tsArray("NOTE_EXTS")))).toEqual(new Set(NOTE_EXTS));
  });

  it("keeps the note family inside the surfaced set", () => {
    for (const ext of NOTE_EXTS) expect(SURFACED_EXTS, ext).toContain(ext);
  });

  // `extract.rs` decides what TEXT a binary contributes to search, keyed on the
  // same extension `textExtract` is keyed on here. Its match ends in a wildcard
  // that means "index the name only", which is a safe default for a format
  // nobody taught it about — and a LIE for the three the registry says have
  // real text inside. Those three are pinned; the rest are free to default.
  it("agrees with Rust's extractor on the formats that carry text", () => {
    const extractRs = read("src-tauri/src/extract.rs");
    const body = extractRs.match(
      /pub fn extractor_for\(ext: &str\) -> Extractor \{([\s\S]*?)\n\}/,
    )?.[1];
    if (body === undefined) throw new Error("could not find extractor_for");
    const arms = new Map<string, string>();
    for (const [, pattern, arm] of body.matchAll(
      /((?:"[^"]+"\s*\|\s*)*"[^"]+")\s*=>\s*Extractor::(\w+)/g,
    )) {
      for (const [, ext] of pattern.matchAll(/"([^"]+)"/g)) arms.set(ext, arm);
    }

    const expected: Record<string, string> = {
      docx: "Docx",
      xlsx: "Xlsx",
      // PDF is the one format Rust declines on purpose, so a TS-side extractor
      // can fill those rows in later. `unsupported` is that hand-off.
      pdf: "Unsupported",
    };
    for (const format of FORMATS) {
      const want = expected[format.textExtract];
      if (!want) continue;
      for (const ext of format.exts) expect(arms.get(ext), ext).toBe(want);
    }
  });

  // #407: a surfaced binary syncs only if the server will store its upload
  // type. `.tar`/`.gz`/`.7z` were missing on both sides; pin the server half
  // so the next format added to the registry cannot surface and then bounce.
  it("has a server MIME for every surfaced attachment format", () => {
    const serverTs = read("../server/src/blobs/formats.ts");
    const body = serverTs.match(/export const EXT_MIME[^=]*=\s*\{([\s\S]*?)\n\};/)?.[1];
    if (body === undefined) throw new Error("could not find EXT_MIME");
    const serverMime = new Map(
      Array.from(body.replace(/\/\/[^\n]*/g, "").matchAll(/"?([\w]+)"?:\s*"([^"]+)"/g), (m) => [m[1], m[2]]),
    );
    // ALLOWED_MIME = EXT_MIME's values + a few accepted spellings
    // (`image/vnd.microsoft.icon` is what the desktop sends for .ico).
    const allowed = new Set([
      ...serverMime.values(),
      ...literals(serverTs, /export const ALLOWED_MIME[^=]*=\s*(?:new Set<string>|lowerSet)\(\[([\s\S]*?)\]\);/),
    ]);
    for (const format of FORMATS) {
      // Optional groups too: switched on, they upload like any other file.
      if (!(format.surface || format.optIn) || format.syncAs !== "attachment") continue;
      for (const ext of format.exts) {
        expect(serverMime.has(ext), ext).toBe(true);
        expect(allowed.has(format.mimes[0]), `${ext} uploads as ${format.mimes[0]}`).toBe(true);
      }
    }
  });

  // #265: what Rust's walk and watcher hide as an app's lock file, the sync
  // layer refuses to pull down and the server refuses to register.
  it("agrees with Rust and the server on transient lock-file prefixes", () => {
    const rust = literals(vaultRs, rustArray("TRANSIENT_PREFIXES"));
    expect(rust.length).toBeGreaterThan(0);
    expect(new Set(rust)).toEqual(new Set(TRANSIENT_PREFIXES));
    const serverTs = read("../server/src/registry/transient.ts");
    expect(new Set(literals(serverTs, /export const TRANSIENT_PREFIXES\s*=\s*\[([\s\S]*?)\];/))).toEqual(
      new Set(TRANSIENT_PREFIXES),
    );
    expect(isTransientFileName("~$Report.docx")).toBe(true);
    expect(isTransientFileName("~WRL0001.tmp")).toBe(true);
    expect(isTransientFileName("~notes.md")).toBe(false);
    expect(isTransientFileName("Report.docx")).toBe(false);
  });
});
