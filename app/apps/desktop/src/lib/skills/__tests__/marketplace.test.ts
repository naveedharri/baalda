import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  findRepoLogo,
  MarketplaceError,
  browseMarketplace,
  loadOriginSkill,
  type MarketplaceListing,
  createGitHubReader,
  describeSkill,
  fetchSkillFolder,
  folderTreeSha,
  githubError,
  importNotes,
  importStatus,
  joinRepoPath,
  manifestSkillPaths,
  mapLimit,
  marketplaceFile,
  originOf,
  parseRepoInput,
  pluginSkillFolders,
  readMarketplace,
  scanSkillFolders,
  skillFolderFiles,
  type GitHubReader,
  type MarketplaceSkill,
  type TreeEntry,
} from "../marketplace";
import type { SkillSummary } from "../types";

const blob = (path: string, extra: Partial<TreeEntry> = {}): TreeEntry => ({
  path,
  mode: "100644",
  type: "blob",
  sha: `sha-${path}`,
  size: 10,
  ...extra,
});
const dir = (path: string): TreeEntry => ({ path, mode: "040000", type: "tree", sha: `tree-${path}` });
const md = (name: string, desc = "Does a thing.") => `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\n`;
const enc = (s: string) => new TextEncoder().encode(s);

describe("parseRepoInput", () => {
  it("parses the accepted shapes", () => {
    expect(parseRepoInput("o/r")).toEqual({ repo: "o/r", ref: null });
    expect(parseRepoInput("o/r@v1.2")).toEqual({ repo: "o/r", ref: "v1.2" });
    expect(parseRepoInput("https://github.com/o/r")).toEqual({ repo: "o/r", ref: null });
    expect(parseRepoInput("https://github.com/o/r.git")).toEqual({ repo: "o/r", ref: null });
    expect(parseRepoInput("github.com/o/r/tree/dev")).toEqual({ repo: "o/r", ref: "dev" });
    expect(parseRepoInput("git@github.com:o/r.git")).toEqual({ repo: "o/r", ref: null });
    expect(parseRepoInput("o/r/")).toEqual({ repo: "o/r", ref: null });
    expect(parseRepoInput("https://github.com/o/r/")).toEqual({ repo: "o/r", ref: null });
  });
  it("lets the explicit ref win", () => {
    expect(parseRepoInput("o/r@v1", "main")).toEqual({ repo: "o/r", ref: "main" });
    expect(parseRepoInput("github.com/o/r/tree/dev", "next")).toEqual({ repo: "o/r", ref: "next" });
  });
  it("refuses what is not a repo", () => {
    expect(parseRepoInput("o")).toBeNull();
    expect(parseRepoInput("o/r/x")).toBeNull();
    expect(parseRepoInput("https://gitlab.com/o/r")).toBeNull();
    expect(parseRepoInput("o/r@bad ref")).toBeNull();
    expect(parseRepoInput("o/r", "bad?ref")).toBeNull();
  });
});

describe("joinRepoPath", () => {
  it("normalises", () => {
    expect(joinRepoPath("", "./a")).toBe("a");
    expect(joinRepoPath("", "a/../b")).toBe("b");
    expect(joinRepoPath("x", "./a")).toBe("x/a");
    expect(joinRepoPath("", "")).toBe("");
    expect(joinRepoPath("", "./")).toBe("");
  });
  it("refuses an escape", () => {
    expect(joinRepoPath("", "../x")).toBeNull();
    expect(joinRepoPath("a", "../../x")).toBeNull();
  });
});

describe("marketplaceFile", () => {
  it("prefers claude over codex", () => {
    const c = ".claude-plugin/marketplace.json";
    const x = ".agents/plugins/marketplace.json";
    expect(marketplaceFile([blob(x), blob(c)])).toEqual({ format: "claude", path: c });
    expect(marketplaceFile([blob(x)])).toEqual({ format: "codex", path: x });
    expect(marketplaceFile([blob("README.md")])).toBeNull();
  });
});

describe("readMarketplace", () => {
  it("reads a relative string source", () => {
    const m = readMarketplace({ name: "mk", plugins: [{ name: "p", description: "d", source: "./plugins/p" }] });
    expect(m.name).toBe("mk");
    expect(m.plugins).toEqual([{ kind: "local", name: "p", description: "d", root: "plugins/p", skills: [] }]);
  });
  it("applies pluginRoot to bare names only", () => {
    const m = readMarketplace({
      metadata: { pluginRoot: "./plugins" },
      plugins: [
        { name: "a", source: "alpha" },
        { name: "b", source: "./beta" },
      ],
    });
    expect(m.plugins.map((p) => (p.kind === "local" ? p.root : null))).toEqual(["plugins/alpha", "beta"]);
  });
  it("reads codex local, github and entry skills", () => {
    const m = readMarketplace({
      plugins: [
        { name: "l", source: { source: "local", path: "./l" }, skills: ["./skills/a"] },
        { name: "g", source: { source: "github", repo: "o/other", ref: "v2", path: "./sub" } },
      ],
    });
    expect(m.plugins[0]).toMatchObject({ kind: "local", root: "l", skills: ["./skills/a"] });
    expect(m.plugins[1]).toMatchObject({ kind: "github", repo: "o/other", ref: "v2", path: "sub" });
  });
  it("lists other source types as unsupported", () => {
    const m = readMarketplace({ plugins: [{ name: "u", source: { source: "url", url: "https://example.test/x.git" } }] });
    expect(m.plugins[0]).toMatchObject({ kind: "unsupported" });
    expect((m.plugins[0] as { reason: string }).reason).toContain("url");
  });
  it("marks an escaping path unsupported", () => {
    const m = readMarketplace({ plugins: [{ name: "e", source: "../outside" }] });
    expect(m.plugins[0].kind).toBe("unsupported");
  });
  it("returns empty for non-objects", () => {
    expect(readMarketplace(null)).toEqual({ name: null, plugins: [] });
    expect(readMarketplace("x")).toEqual({ name: null, plugins: [] });
    expect(readMarketplace(42)).toEqual({ name: null, plugins: [] });
  });
});

describe("pluginSkillFolders", () => {
  const tree = [
    blob("p/skills/a/SKILL.md"),
    blob("p/skills/b/SKILL.md"),
    blob("p/extra/SKILL.md"),
    blob("p/bundle/one/SKILL.md"),
    blob("p/bundle/two/SKILL.md"),
  ];
  it("accepts a listed skill folder", () => {
    expect(pluginSkillFolders(tree, "p", ["./extra"])).toEqual(["p/extra"]);
  });
  it("takes children of a listed non-skill folder", () => {
    expect(pluginSkillFolders(tree, "p", ["bundle"])).toEqual(["p/bundle/one", "p/bundle/two"]);
  });
  it("defaults to <root>/skills/*", () => {
    expect(pluginSkillFolders(tree, "p", [])).toEqual(["p/skills/a", "p/skills/b"]);
  });
  it("lets listed paths replace the default", () => {
    const t = [blob("skills/a/SKILL.md"), blob("skills/b/SKILL.md")];
    expect(pluginSkillFolders(t, "", ["./skills/a"])).toEqual(["skills/a"]);
  });
  it("dedupes and sorts", () => {
    expect(pluginSkillFolders(tree, "p", ["skills/b", "skills", "skills/a"])).toEqual(["p/skills/a", "p/skills/b"]);
  });
});

describe("manifestSkillPaths", () => {
  it("reads a string or a list", () => {
    expect(manifestSkillPaths({ skills: "./s" })).toEqual(["./s"]);
    expect(manifestSkillPaths({ skills: ["./a", 3, "./b"] })).toEqual(["./a", "./b"]);
    expect(manifestSkillPaths(null)).toEqual([]);
    expect(manifestSkillPaths({})).toEqual([]);
  });
});

describe("scanSkillFolders", () => {
  it("finds the root and honours depth", () => {
    expect(scanSkillFolders([blob("SKILL.md")])).toEqual([""]);
    const d5 = "a/b/c/d/e";
    const d6 = "a/b/c/d/e/f";
    expect(scanSkillFolders([blob(`${d5}/SKILL.md`), blob(`${d6}/SKILL.md`)])).toEqual([d5]);
  });
  it("skips node_modules and keeps dotted curated folders", () => {
    const out = scanSkillFolders([
      blob("node_modules/x/SKILL.md"),
      blob("skills/.curated/x/SKILL.md"),
      blob("skills/y/SKILL.md"),
    ]);
    expect(out).toEqual(["skills/.curated/x", "skills/y"]);
  });
});

describe("folderTreeSha", () => {
  it("answers root, nested and missing", () => {
    const tree = [dir("skills"), dir("skills/a")];
    expect(folderTreeSha(tree, "", "ROOT")).toBe("ROOT");
    expect(folderTreeSha(tree, "skills/a", "ROOT")).toBe("tree-skills/a");
    expect(folderTreeSha(tree, "nope", "ROOT")).toBeNull();
  });
});

describe("skillFolderFiles", () => {
  it("applies the upload rules", () => {
    const tree = [
      dir("s"),
      blob("s/SKILL.md"),
      blob("s/scripts/run.sh", { mode: "100755" }),
      blob("s/.hidden"),
      blob("s/node_modules/m.js"),
      blob("s/link", { mode: "120000" }),
      blob("s/sub", { type: "commit", mode: "160000" }),
      blob("s/a:b.txt"),
      blob("s/b.txt"),
      blob("other/SKILL.md"),
    ];
    const r = skillFolderFiles(tree, "s");
    expect(r.files.map((f) => f.path)).toEqual(["SKILL.md", "b.txt", "scripts/run.sh"]);
    expect(r.files.find((f) => f.path === "scripts/run.sh")).toMatchObject({ executable: true, repoPath: "s/scripts/run.sh" });
    expect(r.files[0].executable).toBe(false);
    expect([...r.skipped].sort()).toEqual([".hidden", "a:b.txt", "link", "node_modules/m.js", "sub"].sort());
    expect(r.cap).toBeNull();
  });
  it("reports a cap error for an oversize file", () => {
    const r = skillFolderFiles([blob("s/SKILL.md"), blob("s/big.bin", { size: 5 * 1_048_576 + 1 })], "s");
    expect(r.cap).toBe("skill_file_too_large");
  });
  it("works from the repo root", () => {
    const r = skillFolderFiles([blob("SKILL.md"), blob("x/y.txt")], "");
    expect(r.files.map((f) => f.path)).toEqual(["SKILL.md", "x/y.txt"]);
  });
});

describe("describeSkill", () => {
  it("reads a valid SKILL.md", () => {
    expect(describeSkill(md("pdf-tools", "Edit PDFs."), "skills/pdf-tools", "o/r", null)).toEqual({
      name: "pdf-tools",
      title: "pdf-tools",
      description: "Edit PDFs.",
      problem: null,
    });
  });
  it("falls back to the folder name for an invalid frontmatter name", () => {
    const d = describeSkill(md("My Skill"), "skills/my-skill", "o/r", null);
    expect(d.name).toBe("my-skill");
    expect(d.title).toBe("My Skill");
    expect(d.problem).not.toBeNull();
  });
  it("flags a missing SKILL.md", () => {
    const d = describeSkill(null, "skills/x", "o/r", null);
    expect(d.name).toBe("x");
    expect(d.problem).not.toBeNull();
  });
  it("lets the cap error win", () => {
    const d = describeSkill(md("x"), "x", "o/r", "skill_file_too_large");
    expect(d.problem).toBe("Has a file over 5 MB.");
  });
});

describe("importStatus", () => {
  const origin = { repo: "Acme/Kit", ref: null, path: "skills/a", commitSha: "c".repeat(40), treeSha: "t1" };
  const vs = (over: Partial<SkillSummary>): SkillSummary =>
    ({ id: "id1", name: "a", source: null, ...over }) as SkillSummary;
  const row = { repo: "acme/kit", path: "skills/a", treeSha: "t1", name: "a" };
  it("imported / update", () => {
    expect(importStatus(row, [vs({ source: origin })])).toEqual({ kind: "imported", skillId: "id1" });
    expect(importStatus({ ...row, treeSha: "t2" }, [vs({ source: origin })])).toEqual({ kind: "update", skillId: "id1" });
  });
  it("nameTaken for a different or no source", () => {
    expect(importStatus(row, [vs({})])).toEqual({ kind: "nameTaken", skillId: "id1" });
    expect(importStatus(row, [vs({ source: { ...origin, path: "other" } })])).toEqual({ kind: "nameTaken", skillId: "id1" });
  });
  it("new", () => {
    expect(importStatus(row, [vs({ name: "zzz" })])).toEqual({ kind: "new" });
    expect(importStatus({ ...row, name: null }, [vs({})])).toEqual({ kind: "new" });
  });
});

describe("originOf / importNotes", () => {
  const skill = { repo: "o/r", ref: "dev", path: "s", commitSha: "abcdef1234567890", treeSha: "t", pluginName: null } as MarketplaceSkill;
  it("builds the origin", () => {
    expect(originOf(skill)).toEqual({ repo: "o/r", ref: "dev", path: "s", commitSha: "abcdef1234567890", treeSha: "t" });
    expect(originOf({ ...skill, pluginName: "p" })).toMatchObject({ pluginName: "p" });
  });
  it("writes the notes", () => {
    expect(importNotes(skill)).toBe("Imported from o/r@abcdef1");
  });
});

describe("githubError", () => {
  const h = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null });
  it("404 with and without a token", () => {
    const a = githubError(404, h({}), "o/r", false);
    const b = githubError(404, h({}), "o/r", true);
    expect(a.code).toBe("not_found");
    expect(a.message).toContain("add a GitHub token");
    expect(b.message).toContain("your GitHub token can't see it");
  });
  it("rate limit", () => {
    const e = githubError(403, h({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000000" }), "o/r", false);
    expect(e.code).toBe("rate_limited");
    expect(e.message).toContain("without a token");
    expect(githubError(429, h({ "x-ratelimit-remaining": "0" }), "o/r", true).message).toContain("your token");
  });
  it("401, plain 403 and others", () => {
    expect(githubError(401, h({}), "o/r", true).code).toBe("unauthorized");
    expect(githubError(403, h({}), "o/r", true).code).toBe("forbidden");
    expect(githubError(500, h({}), "o/r", true).code).toBe("other");
  });
});

describe("mapLimit", () => {
  it("keeps order and respects the limit", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3, 0], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, n));
      running--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 0]);
    expect(peak).toBe(2);
  });
  it("handles an empty list", async () => {
    expect(await mapLimit([], 3, async (x) => x)).toEqual([]);
  });
});

// ---- Fake reader ---------------------------------------------------------------

interface FakeRepo {
  tree: TreeEntry[];
  files: Record<string, string | Uint8Array>;
}
function fakeReader(repos: Record<string, FakeRepo>, opts: { rateLimitPath?: string } = {}): GitHubReader {
  const get = (repo: string) => {
    const r = repos[repo];
    if (!r) throw new MarketplaceError("not_found", `no ${repo}`);
    return r;
  };
  return {
    hasToken: false,
    async resolveCommit(repo) {
      get(repo);
      return { commitSha: `${repo.replace("/", "")}`.padEnd(40, "0"), treeSha: `root-${repo}` };
    },
    async tree(repo) {
      return get(repo).tree;
    },
    async readBytes(repo, _commit, path) {
      if (opts.rateLimitPath === path) throw new MarketplaceError("rate_limited", "slow down");
      const f = get(repo).files[path];
      if (f === undefined) throw new MarketplaceError("not_found", path);
      return typeof f === "string" ? enc(f) : f;
    },
  };
}

function treeFor(files: Record<string, string | Uint8Array>): TreeEntry[] {
  const out: TreeEntry[] = [];
  const dirs = new Set<string>();
  for (const [p, c] of Object.entries(files)) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    out.push(blob(p, { size: typeof c === "string" ? c.length : c.length }));
  }
  for (const d of dirs) out.push(dir(d));
  return out;
}
const repoOf = (files: Record<string, string | Uint8Array>): FakeRepo => ({ files, tree: treeFor(files) });

describe("browseMarketplace", () => {
  const main = repoOf({
    ".claude-plugin/marketplace.json": JSON.stringify({
      name: "Acme Market",
      plugins: [
        { name: "one", source: "./plugins/one" },
        { name: "two", source: "./plugins/two", skills: ["./plugins/one/skills/alpha"] },
        { name: "remote", source: { source: "url", url: "https://example.test/r.git" } },
        { name: "ext", source: { source: "github", repo: "acme/second", path: "pkg" } },
      ],
    }),
    "plugins/one/skills/alpha/SKILL.md": md("alpha"),
    "plugins/one/skills/alpha/ref.txt": "r",
    "plugins/one/skills/beta/SKILL.md": md("beta"),
    "plugins/two/skills/gamma/SKILL.md": md("gamma"),
  });
  const second = repoOf({
    "pkg/skills/delta/SKILL.md": md("delta"),
  });

  it("groups plugins, shows duplicates once, and follows github sources", async () => {
    const reader = fakeReader({ "acme/main": main, "acme/second": second });
    const l = await browseMarketplace(reader, { repo: "acme/main", ref: null });
    expect(l.format).toBe("claude");
    expect(l.marketplaceName).toBe("Acme Market");
    expect(l.groups.map((g) => g.pluginName)).toEqual(["one", "two", "remote", "ext"]);
    expect(l.groups[0].skills.map((s) => s.path)).toEqual([
      "plugins/one/skills/alpha",
      "plugins/one/skills/beta",
    ]);
    // "two" lists alpha (already shown under "one"), so it gets nothing
    expect(l.groups[1].skills).toEqual([]);
    expect(l.groups[2].unsupported).toContain("url");
    expect(l.groups[3].skills.map((s) => [s.repo, s.path, s.name])).toEqual([["acme/second", "pkg/skills/delta", "delta"]]);
    expect(l.groups[0].skills[0]).toMatchObject({ pluginName: "one", name: "alpha", problem: null, totalBytes: md("alpha").length + 1 });
  });

  it("falls back to the plain scan when plugins yield nothing", async () => {
    const r = repoOf({
      ".claude-plugin/marketplace.json": JSON.stringify({ plugins: [{ name: "x", source: "./nothing" }] }),
      "tools/solo/SKILL.md": md("solo"),
    });
    const l = await browseMarketplace(fakeReader({ "o/r": r }), { repo: "o/r", ref: null });
    expect(l.format).toBe("skills");
    expect(l.groups).toHaveLength(1);
    expect(l.groups[0].skills.map((s) => s.path)).toEqual(["tools/solo"]);
  });

  it("lists a plain skills repo", async () => {
    const r = repoOf({ "SKILL.md": md("rootskill"), "skills/.curated/q/SKILL.md": md("q") });
    const l = await browseMarketplace(fakeReader({ "o/plain": r }), { repo: "o/plain", ref: "dev" });
    expect(l).toMatchObject({ format: "skills", ref: "dev", marketplaceName: null });
    expect(l.groups[0].skills.map((s) => s.path)).toEqual(["", "skills/.curated/q"]);
    expect(l.groups[0].skills[0].treeSha).toBe("root-o/plain");
  });

  it("hands out the shape first, every row pending, then the described rows", async () => {
    const r = repoOf({ "skills/a/SKILL.md": md("a"), "skills/b/SKILL.md": md("b") });
    const partials: MarketplaceListing[] = [];
    const l = await browseMarketplace(fakeReader({ "o/r": r }), { repo: "o/r", ref: null }, (p) => partials.push(p));
    expect(partials).toHaveLength(1);
    expect(partials[0].groups[0].skills.map((s) => [s.path, s.pending, s.description])).toEqual([
      ["skills/a", true, ""],
      ["skills/b", true, ""],
    ]);
    expect(l.groups[0].skills.every((s) => s.pending === false && s.description !== "")).toBe(true);
  });

  it("loadOriginSkill re-reads one imported folder and reports its tree sha", async () => {
    const r = repoOf({ "skills/a/SKILL.md": md("a"), "skills/a/x.txt": "x" });
    const reader = fakeReader({ "o/r": r });
    const origin = { repo: "o/r", ref: null, path: "skills/a", commitSha: "c".repeat(40), treeSha: "old", pluginName: "p" };
    const row = await loadOriginSkill(reader, origin);
    expect(row).toMatchObject({ path: "skills/a", pluginName: "p", pending: false });
    expect(row!.treeSha).not.toBe("old");
    expect(row!.files.map((f) => f.path)).toEqual(["SKILL.md", "x.txt"]);
    expect(await loadOriginSkill(reader, { ...origin, path: "skills/gone" })).toBeNull();
  });

  it("propagates a rate limit", async () => {
    const r = repoOf({ "skills/a/SKILL.md": md("a") });
    const reader = fakeReader({ "o/r": r }, { rateLimitPath: "skills/a/SKILL.md" });
    await expect(browseMarketplace(reader, { repo: "o/r", ref: null })).rejects.toMatchObject({ code: "rate_limited" });
  });
});

describe("fetchSkillFolder", () => {
  it("returns base64, sha256 and executable flags", async () => {
    const bin = new Uint8Array([0, 1, 2, 250, 255]);
    const r = repoOf({ "s/SKILL.md": md("s"), "s/run.sh": "echo hi", "s/data.bin": bin });
    r.tree = r.tree.map((e) => (e.path === "s/run.sh" ? { ...e, mode: "100755" } : e));
    const reader = fakeReader({ "o/r": r });
    const l = await browseMarketplace(reader, { repo: "o/r", ref: null });
    const skill = l.groups[0].skills[0];
    const out = await fetchSkillFolder(reader, skill);
    expect(out.map((f) => f.path)).toEqual(["SKILL.md", "data.bin", "run.sh"]);
    const sh = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
    const byPath = Object.fromEntries(out.map((f) => [f.path, f]));
    expect(byPath["data.bin"].contentBase64).toBe(Buffer.from(bin).toString("base64"));
    expect(byPath["data.bin"].sha256).toBe(sh(bin));
    expect(byPath["run.sh"].sha256).toBe(sh(enc("echo hi")));
    expect(byPath["run.sh"].executable).toBe(true);
    expect(byPath["SKILL.md"].executable).toBe(false);
  });
});

describe("createGitHubReader", () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("reads raw.githubusercontent.com without a token", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const reader = createGitHubReader({
      token: null,
      fetchImpl: (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return new Response(new Uint8Array([1, 2, 3]));
      }) as unknown as typeof fetch,
    });
    const bytes = await reader.readBytes("o/r", "c0mm1t", "dir/my file.md", "blobsha");
    expect([...bytes]).toEqual([1, 2, 3]);
    expect(calls[0].url).toBe("https://raw.githubusercontent.com/o/r/c0mm1t/dir/my%20file.md");
    expect(reader.hasToken).toBe(false);
  });

  it("uses the blobs API with a token", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const reader = createGitHubReader({
      token: "tok",
      fetchImpl: (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return new Response(new Uint8Array([9]));
      }) as unknown as typeof fetch,
    });
    await reader.readBytes("o/r", "c0mm1t", "a.md", "blobsha");
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/git/blobs/blobsha");
    const h = calls[0].init?.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer tok");
    expect(h.Accept).toBe("application/vnd.github.raw+json");
    expect(reader.hasToken).toBe(true);
  });

  it("resolves HEAD when the ref is null", async () => {
    const urls: string[] = [];
    const reader = createGitHubReader({
      token: null,
      fetchImpl: (async (url: string) => {
        urls.push(url);
        return json({ sha: "c1", commit: { tree: { sha: "t1" } } });
      }) as unknown as typeof fetch,
    });
    expect(await reader.resolveCommit("o/r", null)).toEqual({ commitSha: "c1", treeSha: "t1" });
    await reader.resolveCommit("o/r", "feat/x");
    expect(urls[0]).toBe("https://api.github.com/repos/o/r/commits/HEAD");
    expect(urls[1]).toBe("https://api.github.com/repos/o/r/commits/feat%2Fx");
  });

  it("refuses a truncated tree", async () => {
    const reader = createGitHubReader({
      token: null,
      fetchImpl: (async () => json({ truncated: true, tree: [] })) as unknown as typeof fetch,
    });
    await expect(reader.tree("o/r", "t")).rejects.toMatchObject({ code: "truncated" });
  });

  it("maps a thrown fetch to network", async () => {
    const reader = createGitHubReader({
      token: null,
      fetchImpl: (async () => {
        throw new TypeError("offline");
      }) as unknown as typeof fetch,
    });
    const err = await reader.resolveCommit("o/r", null).catch((e) => e);
    expect(err).toBeInstanceOf(MarketplaceError);
    expect(err.code).toBe("network");
  });

  it("maps HTTP failures through githubError", async () => {
    const reader = createGitHubReader({
      token: null,
      fetchImpl: (async () => new Response("", { status: 404 })) as unknown as typeof fetch,
    });
    await expect(reader.resolveCommit("o/r", null)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("findRepoLogo", () => {
  const blob = (path: string, size = 100) => ({ path, mode: "100644", type: "blob" as const, sha: `sha-${path}`, size });
  it("prefers the manifest folder, then the root, matching names case-insensitively", () => {
    expect(findRepoLogo([blob("logo.png"), blob(".claude-plugin/Logo.svg")])).toEqual({ path: ".claude-plugin/Logo.svg", sha: "sha-.claude-plugin/Logo.svg" });
    expect(findRepoLogo([blob("docs/icon.png"), blob("icon.png")])?.path).toBe("icon.png");
  });
  it("skips oversized and non-image files, and answers null when there is none", () => {
    expect(findRepoLogo([blob("logo.png", 600 * 1024), blob("logo.txt"), blob("plugins/x/logo.png")])).toBeNull();
  });
});
