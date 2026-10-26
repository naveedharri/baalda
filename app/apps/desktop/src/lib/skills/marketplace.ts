// Import skills from GitHub repos (docs/SKILLS.md "Addendum — Marketplace import").
//
// Three repo shapes, detected on one recursive tree listing, first match wins:
// a Claude plugin marketplace (`.claude-plugin/marketplace.json`), a Codex one
// (`.agents/plugins/marketplace.json`), or a plain repo of `SKILL.md` folders.
// The parsers are pure and take what was already fetched; the GitHub reader at
// the bottom does the fetching through an injected `fetch`, so the same code
// runs in the webview, in tests and in a node smoke script.
//
// Budget: browsing costs two API calls per repo (commit, tree) plus one read
// per SKILL.md; without a token those reads go to raw.githubusercontent.com,
// which does not count against GitHub's 60-requests-an-hour anonymous limit.

import type { SkillFileInput, SkillOrigin, SkillSummary } from "./types";
import {
  bytesToBase64,
  CAP_FACT_TEXT,
  checkSkillCaps,
  isValidSkillName,
  parseSkillFrontmatter,
  sha256OfBytes,
  skillMdProblemText,
  skillPathProblem,
  suggestSkillName,
  type SkillCapError,
} from "./validate";

export type MarketplaceFormat = "claude" | "codex" | "skills";

export interface TreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

export interface RepoRef {
  repo: string;
  ref: string | null;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REF_RE = /^[A-Za-z0-9._/-]{1,255}$/;

/**
 * `owner/repo`, `owner/repo@ref`, `https://github.com/owner/repo[.git][/tree/<ref>…]`
 * or `git@github.com:owner/repo.git`; `refInput` (the separate field) wins over
 * a ref in the text. Null when it is not a repo. A ref with slashes only works
 * through `refInput`: in a `/tree/` URL the path after the ref is ambiguous.
 */
export function parseRepoInput(input: string, refInput?: string | null): RepoRef | null {
  let text = input.trim();
  let ref: string | null = null;
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)(?:\/tree\/([^/\s#?]+))?/i.exec(text);
  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s]+)$/i.exec(text);
  if (url) {
    text = `${url[1]}/${url[2]}`;
    ref = url[3] ? decodeURIComponent(url[3]) : null;
  } else if (ssh) {
    text = `${ssh[1]}/${ssh[2]}`;
  } else {
    const at = text.indexOf("@");
    if (at > 0) {
      ref = text.slice(at + 1) || null;
      text = text.slice(0, at);
    }
  }
  const repo = text.replace(/\.git$/i, "").replace(/\/+$/, "");
  const explicit = refInput?.trim();
  if (explicit) ref = explicit;
  if (!REPO_RE.test(repo) || repo.length > 200) return null;
  if (ref !== null && !REF_RE.test(ref)) return null;
  return { repo, ref };
}

// ---- Paths ------------------------------------------------------------------

/** Join repo paths; null when the result would leave the repo. */
export function joinRepoPath(base: string, rel: string): string | null {
  const parts = base ? base.split("/") : [];
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join("/");
}

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function skillMdOf(folder: string): string {
  return folder ? `${folder}/SKILL.md` : "SKILL.md";
}

function blobPaths(tree: readonly TreeEntry[]): Set<string> {
  return new Set(tree.filter((e) => e.type === "blob").map((e) => e.path));
}

// ---- Format detection --------------------------------------------------------

export const CLAUDE_MARKETPLACE = ".claude-plugin/marketplace.json";
export const CODEX_MARKETPLACE = ".agents/plugins/marketplace.json";

/** Which marketplace manifest the tree carries, if any. */
export function marketplaceFile(tree: readonly TreeEntry[]): { format: "claude" | "codex"; path: string } | null {
  const blobs = blobPaths(tree);
  if (blobs.has(CLAUDE_MARKETPLACE)) return { format: "claude", path: CLAUDE_MARKETPLACE };
  if (blobs.has(CODEX_MARKETPLACE)) return { format: "codex", path: CODEX_MARKETPLACE };
  return null;
}

/** Where a plugin's manifest sits, by marketplace format. */
export function pluginManifestPath(format: "claude" | "codex", root: string): string {
  return joinRepoPath(root, format === "claude" ? ".claude-plugin/plugin.json" : ".codex-plugin/plugin.json") ?? "";
}

export type PluginPlan =
  | { kind: "local"; name: string; description: string | null; root: string; skills: string[] }
  | { kind: "github"; name: string; description: string | null; repo: string; ref: string | null; path: string; skills: string[] }
  | { kind: "unsupported"; name: string; description: string | null; reason: string };

function stringList(v: unknown): string[] {
  if (typeof v === "string") return [v];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * The plugins a marketplace manifest lists. Relative sources resolve against
 * `metadata.pluginRoot` (Claude) when set; `{source:"github"}` points at another
 * repo; every other source type is listed as not supported yet.
 */
export function readMarketplace(json: unknown): { name: string | null; plugins: PluginPlan[] } {
  if (!json || typeof json !== "object") return { name: null, plugins: [] };
  const o = json as Record<string, unknown>;
  const meta = (o.metadata && typeof o.metadata === "object" ? o.metadata : {}) as Record<string, unknown>;
  const pluginRoot = typeof meta.pluginRoot === "string" ? meta.pluginRoot : "";
  const list = Array.isArray(o.plugins) ? o.plugins : [];
  const plugins: PluginPlan[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    const name = typeof p.name === "string" && p.name ? p.name : "plugin";
    const description = typeof p.description === "string" ? p.description : null;
    const skills = stringList(p.skills);
    const src = p.source;
    const localPath =
      typeof src === "string"
        ? src
        : src && typeof src === "object" && ((src as { source?: unknown }).source === "local" || (src as { source?: unknown }).source === undefined) &&
            typeof (src as { path?: unknown }).path === "string"
          ? (src as { path: string }).path
          : null;
    if (localPath !== null) {
      const viaRoot = localPath.startsWith("./") || localPath.startsWith("../") || !pluginRoot ? localPath : `${pluginRoot}/${localPath}`;
      const root = joinRepoPath("", viaRoot);
      if (root === null) plugins.push({ kind: "unsupported", name, description, reason: "Its folder is outside the repository." });
      else plugins.push({ kind: "local", name, description, root, skills });
      continue;
    }
    if (src && typeof src === "object" && (src as { source?: unknown }).source === "github") {
      const g = src as { repo?: unknown; ref?: unknown; path?: unknown };
      const repo = typeof g.repo === "string" ? g.repo : "";
      if (REPO_RE.test(repo)) {
        const ref = typeof g.ref === "string" && REF_RE.test(g.ref) ? g.ref : null;
        const path = typeof g.path === "string" ? joinRepoPath("", g.path) ?? "" : "";
        plugins.push({ kind: "github", name, description, repo, ref, path, skills });
        continue;
      }
    }
    const type = src && typeof src === "object" && typeof (src as { source?: unknown }).source === "string"
      ? (src as { source: string }).source
      : "unknown";
    plugins.push({ kind: "unsupported", name, description, reason: `"${type}" sources are not supported yet.` });
  }
  return { name: typeof o.name === "string" ? o.name : null, plugins };
}

/** A plugin manifest's own `skills` paths (string or list), if any. */
export function manifestSkillPaths(json: unknown): string[] {
  return json && typeof json === "object" ? stringList((json as { skills?: unknown }).skills) : [];
}

/**
 * Skill folders of one plugin rooted at `root`: each listed path is a skill
 * folder when it holds SKILL.md, otherwise its direct child folders that do.
 * With nothing listed, `<root>/skills/*`. Listed paths replace the default:
 * anthropics/skills roots every plugin at "./" and names a different subset
 * of the same `skills/` folder for each. Sorted, without duplicates.
 */
export function pluginSkillFolders(tree: readonly TreeEntry[], root: string, listed: readonly string[]): string[] {
  const blobs = blobPaths(tree);
  const out = new Set<string>();
  const scan = (dir: string) => {
    if (blobs.has(skillMdOf(dir))) {
      out.add(dir);
      return;
    }
    const prefix = dir ? `${dir}/` : "";
    for (const p of blobs) {
      if (!p.startsWith(prefix) || !p.endsWith("/SKILL.md")) continue;
      const folder = parentOf(p);
      if (parentOf(folder) === dir) out.add(folder);
    }
  };
  for (const rel of listed.length > 0 ? listed : ["skills"]) {
    const dir = joinRepoPath(root, rel);
    if (dir !== null) scan(dir);
  }
  return [...out].sort();
}

const SKIP_DIRS = new Set(["node_modules", "__pycache__", ".venv", "venv", "dist", "build", "target"]);

/** Every SKILL.md folder at most `maxDepth` levels deep, outside skipped folders. */
export function scanSkillFolders(tree: readonly TreeEntry[], maxDepth = 5): string[] {
  const out: string[] = [];
  for (const e of tree) {
    if (e.type !== "blob" || (e.path !== "SKILL.md" && !e.path.endsWith("/SKILL.md"))) continue;
    const folder = parentOf(e.path);
    const parts = folder ? folder.split("/") : [];
    if (parts.length > maxDepth || parts.some((p) => SKIP_DIRS.has(p))) continue;
    out.push(folder);
  }
  return out.sort();
}

/** A folder's tree sha: its `tree` entry, or the root tree sha for "". */
export function folderTreeSha(tree: readonly TreeEntry[], folder: string, rootTreeSha: string): string | null {
  if (folder === "") return rootTreeSha;
  return tree.find((e) => e.type === "tree" && e.path === folder)?.sha ?? null;
}

// ---- One skill folder's files -------------------------------------------------

export interface FolderFile {
  /** Path inside the skill folder (the skill relPath). */
  path: string;
  /** Path inside the repo. */
  repoPath: string;
  blobSha: string;
  size: number;
  executable: boolean;
}

/**
 * The files an import would take from `folder`, with the upload rules (§4.5):
 * dot-components, build/dependency folders, symlinks, submodules and paths
 * failing §1.2 are skipped and named. Caps are judged on tree sizes.
 */
export function skillFolderFiles(
  tree: readonly TreeEntry[],
  folder: string,
): { files: FolderFile[]; skipped: string[]; cap: SkillCapError | null } {
  const prefix = folder ? `${folder}/` : "";
  const files: FolderFile[] = [];
  const skipped: string[] = [];
  for (const e of tree) {
    if (!e.path.startsWith(prefix) || e.type === "tree") continue;
    const rel = e.path.slice(prefix.length);
    const parts = rel.split("/");
    if (parts.some((p) => p.startsWith(".") || SKIP_DIRS.has(p))) {
      skipped.push(rel);
      continue;
    }
    if (e.type === "commit" || e.mode === "120000" || skillPathProblem(rel) !== null) {
      skipped.push(rel);
      continue;
    }
    files.push({ path: rel, repoPath: e.path, blobSha: e.sha, size: e.size ?? 0, executable: e.mode === "100755" });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, skipped, cap: checkSkillCaps(files) };
}

// ---- Listing ----------------------------------------------------------------

export interface MarketplaceSkill {
  /** `${repo}:${path}` */
  key: string;
  repo: string;
  ref: string | null;
  commitSha: string;
  path: string;
  treeSha: string;
  pluginName: string | null;
  /** The name the vault skill would get; null when none is usable. */
  name: string | null;
  /** What SKILL.md calls it, or the folder name. */
  title: string;
  description: string;
  /** Why it can't be imported as is (bad SKILL.md, too large); null when fine. */
  problem: string | null;
  /** True until its SKILL.md has been read (`browseMarketplace`'s `onPartial`). */
  pending?: boolean;
  files: FolderFile[];
  skipped: string[];
  totalBytes: number;
}

export interface MarketplaceGroup {
  pluginName: string | null;
  description: string | null;
  /** Set when the plugin's source type can't be read yet. */
  unsupported: string | null;
  skills: MarketplaceSkill[];
}

export interface MarketplaceListing {
  repo: string;
  ref: string | null;
  commitSha: string;
  format: MarketplaceFormat;
  marketplaceName: string | null;
  groups: MarketplaceGroup[];
}

const CAP_TEXT = CAP_FACT_TEXT;

/** The vault name for a skill: SKILL.md's `name` when valid, else the folder name made valid. */
export function skillNameFor(frontmatterName: string | null, folder: string, repo: string): string | null {
  if (frontmatterName && isValidSkillName(frontmatterName)) return frontmatterName;
  const fallback = suggestSkillName(folder ? baseName(folder) : baseName(repo));
  return isValidSkillName(fallback) ? fallback : null;
}

/** Name, description and problem for a listing row, from SKILL.md's text. */
export function describeSkill(
  skillMd: string | null,
  folder: string,
  repo: string,
  cap: SkillCapError | null,
): Pick<MarketplaceSkill, "name" | "title" | "description" | "problem"> {
  const fm = skillMd === null ? null : parseSkillFrontmatter(skillMd);
  const rawName = fm?.ok ? fm.name : null;
  const name = skillNameFor(rawName, folder, repo);
  let problem: string | null = null;
  if (cap) problem = CAP_TEXT[cap];
  else if (!fm) problem = "Its SKILL.md couldn't be read.";
  else if (!fm.ok) problem = skillMdProblemText(fm.reason, name ?? "");
  else if (!name) problem = "Its name can't be used for a skill.";
  else if (fm.name !== name) problem = `Its SKILL.md name "${fm.name}" must be lowercase letters, digits and hyphens.`;
  return {
    name,
    title: rawName ?? (folder ? baseName(folder) : baseName(repo)),
    description: fm?.ok ? fm.description : "",
    problem,
  };
}

export type ImportStatus =
  | { kind: "new" }
  | { kind: "imported"; skillId: string }
  | { kind: "update"; skillId: string }
  | { kind: "nameTaken"; skillId: string };

/** How a listed skill relates to the vault's skills. */
export function importStatus(skill: Pick<MarketplaceSkill, "repo" | "path" | "treeSha" | "name">, vault: readonly SkillSummary[]): ImportStatus {
  const same = vault.find(
    (s) => s.source && s.source.repo.toLowerCase() === skill.repo.toLowerCase() && s.source.path === skill.path,
  );
  if (same) return same.source!.treeSha === skill.treeSha ? { kind: "imported", skillId: same.id } : { kind: "update", skillId: same.id };
  const taken = skill.name ? vault.find((s) => s.name === skill.name) : undefined;
  return taken ? { kind: "nameTaken", skillId: taken.id } : { kind: "new" };
}

/** The `source` recorded on an imported skill. */
export function originOf(skill: MarketplaceSkill): SkillOrigin {
  return {
    repo: skill.repo,
    ref: skill.ref,
    path: skill.path,
    commitSha: skill.commitSha,
    treeSha: skill.treeSha,
    ...(skill.pluginName ? { pluginName: skill.pluginName.slice(0, 100) } : {}),
  };
}

export function importNotes(skill: Pick<MarketplaceSkill, "repo" | "commitSha">): string {
  return `Imported from ${skill.repo}@${skill.commitSha.slice(0, 7)}`;
}

// ---- GitHub reader -------------------------------------------------------------

export type MarketplaceErrorCode = "not_found" | "rate_limited" | "unauthorized" | "forbidden" | "truncated" | "network" | "other";

export class MarketplaceError extends Error {
  constructor(
    public code: MarketplaceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MarketplaceError";
  }
}

export interface GitHubReader {
  hasToken: boolean;
  resolveCommit(repo: string, ref: string | null): Promise<{ commitSha: string; treeSha: string }>;
  tree(repo: string, treeSha: string): Promise<TreeEntry[]>;
  /** One file's bytes at a commit. */
  readBytes(repo: string, commitSha: string, path: string, blobSha: string): Promise<Uint8Array>;
}

const API = "https://api.github.com";

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function timeOf(epochSeconds: string | null): string | null {
  const n = Number(epochSeconds);
  if (!epochSeconds || !Number.isFinite(n)) return null;
  return new Date(n * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** A failed GitHub answer, in plain words. */
export function githubError(status: number, headers: { get(name: string): string | null }, repo: string, hasToken: boolean): MarketplaceError {
  if ((status === 403 || status === 429) && headers.get("x-ratelimit-remaining") === "0") {
    const at = timeOf(headers.get("x-ratelimit-reset"));
    return new MarketplaceError(
      "rate_limited",
      hasToken
        ? `GitHub's request limit for your token is used up${at ? `; it resets at ${at}` : ""}.`
        : `GitHub's limit for requests without a token is used up${at ? ` until ${at}` : ""}. Add a GitHub token below to keep going.`,
    );
  }
  if (status === 404) {
    return new MarketplaceError(
      "not_found",
      hasToken
        ? `Couldn't find ${repo}, or your GitHub token can't see it.`
        : `Couldn't find ${repo}. If it's private, add a GitHub token below.`,
    );
  }
  if (status === 401) return new MarketplaceError("unauthorized", "GitHub refused the saved token. Replace it below.");
  if (status === 403) return new MarketplaceError("forbidden", `GitHub refused access to ${repo}.`);
  return new MarketplaceError("other", `GitHub answered ${status}.`);
}

export function createGitHubReader({ fetchImpl, token }: { fetchImpl: typeof fetch; token: string | null }): GitHubReader {
  const headers = (accept = "application/vnd.github+json"): Record<string, string> => ({
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  });
  const get = async (url: string, repo: string, accept?: string): Promise<Response> => {
    let res: Response;
    try {
      res = await fetchImpl(url, { headers: url.startsWith(API) ? headers(accept) : {} });
    } catch {
      throw new MarketplaceError("network", "Couldn't reach GitHub. Check your connection.");
    }
    if (!res.ok) throw githubError(res.status, res.headers, repo, !!token);
    return res;
  };
  return {
    hasToken: !!token,
    async resolveCommit(repo, ref) {
      const res = await get(`${API}/repos/${repo}/commits/${encodeURIComponent(ref ?? "HEAD")}`, repo);
      const body = (await res.json()) as { sha?: unknown; commit?: { tree?: { sha?: unknown } } };
      const commitSha = typeof body.sha === "string" ? body.sha : "";
      const treeSha = typeof body.commit?.tree?.sha === "string" ? body.commit.tree.sha : "";
      if (!commitSha || !treeSha) throw new MarketplaceError("other", `GitHub sent an unexpected answer for ${repo}.`);
      return { commitSha, treeSha };
    },
    async tree(repo, treeSha) {
      const res = await get(`${API}/repos/${repo}/git/trees/${treeSha}?recursive=1`, repo);
      const body = (await res.json()) as { truncated?: unknown; tree?: unknown };
      if (body.truncated === true) {
        throw new MarketplaceError("truncated", `${repo} is too large to browse in one listing.`);
      }
      return (Array.isArray(body.tree) ? body.tree : []).filter(
        (e): e is TreeEntry => !!e && typeof e.path === "string" && typeof e.sha === "string" && typeof e.type === "string",
      );
    },
    async readBytes(repo, commitSha, path, blobSha) {
      // With a token the API serves private repos; without one raw.githubusercontent
      // spares the anonymous API budget.
      const res = token
        ? await get(`${API}/repos/${repo}/git/blobs/${blobSha}`, repo, "application/vnd.github.raw+json")
        : await get(`https://raw.githubusercontent.com/${repo}/${commitSha}/${encodePath(path)}`, repo);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

/** Run `fn` over `items`, at most `limit` at a time, keeping order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const CONCURRENCY = 6;

async function readText(reader: GitHubReader, repo: string, commitSha: string, tree: readonly TreeEntry[], path: string): Promise<string | null> {
  const e = tree.find((t) => t.type === "blob" && t.path === path);
  if (!e) return null;
  try {
    return new TextDecoder().decode(await reader.readBytes(repo, commitSha, path, e.sha));
  } catch (err) {
    if (err instanceof MarketplaceError && err.code === "rate_limited") throw err;
    return null;
  }
}

async function readJson(reader: GitHubReader, repo: string, commitSha: string, tree: readonly TreeEntry[], path: string): Promise<unknown> {
  const text = await readText(reader, repo, commitSha, tree, path);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

interface RepoSnapshot {
  repo: string;
  ref: string | null;
  commitSha: string;
  treeSha: string;
  tree: TreeEntry[];
}

async function snapshot(reader: GitHubReader, repo: string, ref: string | null): Promise<RepoSnapshot> {
  const { commitSha, treeSha } = await reader.resolveCommit(repo, ref);
  return { repo, ref, commitSha, treeSha, tree: await reader.tree(repo, treeSha) };
}

interface PendingRow {
  row: MarketplaceSkill;
  snap: RepoSnapshot;
}

/** Rows from the tree alone: sizes and sha known, SKILL.md not read yet. */
function structuralRows(snap: RepoSnapshot, folders: readonly string[], pluginName: string | null): PendingRow[] {
  const out: PendingRow[] = [];
  for (const folder of folders) {
    const treeSha = folderTreeSha(snap.tree, folder, snap.treeSha);
    if (!treeSha) continue;
    const { files, skipped, cap } = skillFolderFiles(snap.tree, folder);
    const row: MarketplaceSkill = {
      key: `${snap.repo}:${folder}`,
      repo: snap.repo,
      ref: snap.ref,
      commitSha: snap.commitSha,
      path: folder,
      treeSha,
      pluginName,
      name: skillNameFor(null, folder, snap.repo),
      title: folder ? baseName(folder) : baseName(snap.repo),
      description: "",
      problem: cap ? CAP_TEXT[cap] : null,
      pending: true,
      files,
      skipped,
      totalBytes: files.reduce((n, f) => n + f.size, 0),
    };
    out.push({ row, snap });
  }
  return out;
}

const DESCRIBE_CONCURRENCY = 16;

/**
 * Browse one repo: detect its format and list its skills. Only each SKILL.md is
 * read (name + description), never the other files. `onPartial` gets the
 * listing as soon as its shape is known, every row `pending`, so a large
 * marketplace shows its rows while the descriptions arrive.
 */
export async function browseMarketplace(
  reader: GitHubReader,
  source: RepoRef,
  onPartial?: (listing: MarketplaceListing) => void,
): Promise<MarketplaceListing> {
  const snap = await snapshot(reader, source.repo, source.ref);
  const base = { repo: snap.repo, ref: snap.ref, commitSha: snap.commitSha };
  let format: MarketplaceFormat = "skills";
  let marketplaceName: string | null = null;
  let shape: { group: MarketplaceGroup; rows: PendingRow[] }[] = [];

  const file = marketplaceFile(snap.tree);
  if (file) {
    const market = readMarketplace(await readJson(reader, snap.repo, snap.commitSha, snap.tree, file.path));
    // A folder two plugins both list is shown once, under the first.
    const seen = new Set<string>();
    for (const plugin of market.plugins) {
      const group: MarketplaceGroup = { pluginName: plugin.name, description: plugin.description, unsupported: null, skills: [] };
      const entry = { group, rows: [] as PendingRow[] };
      shape.push(entry);
      if (plugin.kind === "unsupported") {
        group.unsupported = plugin.reason;
        continue;
      }
      try {
        const where = plugin.kind === "local" ? snap : await snapshot(reader, plugin.repo, plugin.ref);
        const root = plugin.kind === "local" ? plugin.root : plugin.path;
        const manifest = await readJson(reader, where.repo, where.commitSha, where.tree, pluginManifestPath(file.format, root));
        const folders = pluginSkillFolders(where.tree, root, [...plugin.skills, ...manifestSkillPaths(manifest)]);
        const fresh = folders.filter((f) => !seen.has(`${where.repo}:${f}`));
        for (const f of fresh) seen.add(`${where.repo}:${f}`);
        entry.rows = structuralRows(where, fresh, plugin.name);
      } catch (e) {
        if (e instanceof MarketplaceError && e.code === "rate_limited") throw e;
        group.unsupported = e instanceof Error ? e.message : String(e);
      }
    }
    if (shape.some((g) => g.rows.length > 0)) {
      format = file.format;
      marketplaceName = market.name;
    } else {
      shape = [];
    }
  }
  if (shape.length === 0) {
    shape = [{
      group: { pluginName: null, description: null, unsupported: null, skills: [] },
      rows: structuralRows(snap, scanSkillFolders(snap.tree), null),
    }];
  }

  const listing = (): MarketplaceListing => ({
    ...base,
    format,
    marketplaceName,
    groups: shape.map(({ group, rows }) => ({ ...group, skills: rows.map((r) => r.row) })),
  });
  onPartial?.(listing());

  const all = shape.flatMap((g) => g.rows);
  await mapLimit(all, DESCRIBE_CONCURRENCY, async (p) => {
    const md = await readText(reader, p.snap.repo, p.snap.commitSha, p.snap.tree, skillMdOf(p.row.path));
    const cap = checkSkillCaps(p.row.files);
    p.row = { ...p.row, ...describeSkill(md, p.row.path, p.snap.repo, cap), pending: false };
  });
  return listing();
}

/**
 * An imported skill's folder as its source repo has it NOW, for "Pull update"
 * on the skill's own page: one commit + one tree call, no SKILL.md read. Null
 * when the folder is gone upstream. Compare `treeSha` with the stored origin's.
 */
export async function loadOriginSkill(reader: GitHubReader, origin: SkillOrigin): Promise<MarketplaceSkill | null> {
  const snap = await snapshot(reader, origin.repo, origin.ref);
  const [row] = structuralRows(snap, [origin.path], origin.pluginName ?? null);
  if (!row || !snap.tree.some((e) => e.type === "blob" && e.path === skillMdOf(origin.path))) return null;
  return { ...row.row, pending: false };
}

/** Download a listed skill's files as upload inputs (sha256 computed here). */
export async function fetchSkillFolder(reader: GitHubReader, skill: MarketplaceSkill): Promise<SkillFileInput[]> {
  return mapLimit(skill.files, CONCURRENCY, async (f) => {
    const bytes = await reader.readBytes(skill.repo, skill.commitSha, f.repoPath, f.blobSha);
    return {
      path: f.path,
      contentBase64: bytesToBase64(bytes),
      executable: f.executable,
      sha256: await sha256OfBytes(bytes),
    };
  });
}

/** "Claude plugin marketplace", "Codex plugin marketplace" or "Skills folder". */
export function formatLabel(format: MarketplaceFormat): string {
  return format === "claude" ? "Claude plugin marketplace" : format === "codex" ? "Codex plugin marketplace" : "Skills repository";
}

export interface MarketplacePeek {
  format: MarketplaceFormat;
  /** Skill folders found from the structure alone (no SKILL.md reads). */
  skills: number;
}

const peekCache = new Map<string, Promise<MarketplacePeek>>();

/**
 * A cheap look at a repo for the Add dialog's live check: the commit and tree
 * calls plus, for a marketplace, its manifest. Counts skill folders from the
 * structure only; plugins hosted in other repos aren't followed. Cached per
 * repo@ref for the session (a failure is not cached).
 */
export function peekMarketplace(reader: GitHubReader, source: RepoRef): Promise<MarketplacePeek> {
  const key = `${source.repo.toLowerCase()}@${source.ref ?? ""}`;
  const hit = peekCache.get(key);
  if (hit) return hit;
  const p = (async (): Promise<MarketplacePeek> => {
    const snap = await snapshot(reader, source.repo, source.ref);
    const file = marketplaceFile(snap.tree);
    if (file) {
      const market = readMarketplace(await readJson(reader, snap.repo, snap.commitSha, snap.tree, file.path));
      const folders = new Set<string>();
      for (const plugin of market.plugins) {
        if (plugin.kind !== "local") continue;
        for (const f of pluginSkillFolders(snap.tree, plugin.root, plugin.skills)) folders.add(f);
      }
      if (folders.size > 0) return { format: file.format, skills: folders.size };
    }
    return { format: "skills", skills: scanSkillFolders(snap.tree).length };
  })();
  peekCache.set(key, p);
  p.catch(() => peekCache.delete(key));
  return p;
}
