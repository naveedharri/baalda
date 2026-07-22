// Content pipeline for the demo seed: mirror the source vault's real structure,
// then synthesize extra "activity" notes to push the tree past the target size,
// and generate clean per-folder index notes so the vault reads well on camera.

import { promises as fs } from "node:fs";
import path from "node:path";
import { mulberry32, type TeamMember } from "./config.js";

/** A note to create: its vault-relative posix path + markdown body. */
export interface PlannedNote {
  relPath: string; // e.g. "Projects/Agency/plan.md"
  title: string; // display title (basename without extension)
  body: string;
  /** Index of the team member who "authored" it (round-robins for activity). */
  authorIndex: number;
}

const IGNORED_DIRS = new Set(["node_modules"]);

/**
 * Recursively collect clean markdown files: skips dotfiles/dot-dirs (.git,
 * .obsidian, .trash, .claude, …) and node_modules — exactly what Baalda itself
 * would never sync — and returns vault-relative posix paths, sorted for a
 * stable, reproducible layout.
 */
export async function collectRealNotes(
  root: string,
  maxFiles: number,
): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue; // dotfiles + dot-dirs (incl .trash)
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue;
        await walk(path.join(dir, e.name));
      } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
        out.push(path.relative(root, path.join(dir, e.name)).split(path.sep).join("/"));
      }
    }
  }
  await walk(root);
  out.sort();
  return out.slice(0, maxFiles);
}

/** Title from a note's relative path (basename minus extension). */
export function titleFromRelPath(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  return base.replace(/\.md$/i, "");
}

/** Read a real note's body, trimmed to a byte budget (keeps the seed light). */
export async function readNoteBody(
  root: string,
  relPath: string,
  maxBytes: number,
): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(root, relPath), "utf8");
    if (Buffer.byteLength(raw, "utf8") <= maxBytes) return raw;
    return `${raw.slice(0, maxBytes)}\n\n> … (trimmed for the demo seed) …\n`;
  } catch {
    return `# ${titleFromRelPath(relPath)}\n\n_(source file unreadable — placeholder)_\n`;
  }
}

/** Every distinct ancestor folder path implied by a set of note rel-paths. */
export function folderPathsFor(relPaths: readonly string[]): string[] {
  const set = new Set<string>();
  for (const rel of relPaths) {
    const parts = rel.split("/");
    parts.pop(); // drop filename
    let acc = "";
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p;
      set.add(acc);
    }
  }
  // Shallow-first so parents are created before children.
  return [...set].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// Synthetic "activity" notes — daily standups, meeting notes, project status,
// and per-member profiles. These make the tree exceed the target size AND look
// like a busy team space, and they wikilink to real notes so the graph lights up.
// ---------------------------------------------------------------------------

const MEETING_TOPICS = [
  "Weekly Sync", "Roadmap Review", "Design Critique", "Growth Standup",
  "Content Planning", "Customer Deep-Dive", "Retro", "Launch Readiness",
  "Hiring Loop", "Metrics Review", "Support Triage", "Architecture Review",
];
const STATUS_VERBS = [
  "shipped", "drafted", "reviewed", "unblocked", "scoped", "prototyped",
  "migrated", "instrumented", "refactored", "documented",
];

function dateStr(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

/**
 * Generate `count` synthetic notes under a clearly-labelled "Team Journal"
 * top-level folder (kept separate so the mirrored real vault stays pristine).
 */
export function synthesizeNotes(
  count: number,
  team: readonly TeamMember[],
  realTitles: readonly string[],
): PlannedNote[] {
  if (count <= 0) return [];
  const rand = mulberry32(0x5eed_1234);
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)];
  const notes: PlannedNote[] = [];
  const link = () => (realTitles.length ? `[[${pick(realTitles)}]]` : "the roadmap");

  // Per-member profile pages (nice for the Team view + presence attribution).
  team.forEach((m, i) => {
    notes.push({
      relPath: `Team Journal/People/${m.name}.md`,
      title: m.name,
      authorIndex: i,
      body:
        `# ${m.name}\n\n- **Role:** ${m.role}\n- **Email:** ${m.email}\n\n` +
        `## Focus areas\nWorking across ${link()} and ${link()}.\n\n` +
        `## Recent\n- ${dateStr(1)} — ${pick(STATUS_VERBS)} ${link()}\n` +
        `- ${dateStr(3)} — ${pick(STATUS_VERBS)} ${link()}\n`,
    });
  });

  let n = 0;
  while (notes.length < count) {
    const author = n % team.length;
    const kind = n % 3;
    if (kind === 0) {
      // Daily standup for one member.
      const m = team[author];
      const day = dateStr(Math.floor(n / team.length) % 90);
      notes.push({
        relPath: `Team Journal/Standups/${day}/${m.name.split(" ")[0]}.md`,
        title: `${day} · ${m.name.split(" ")[0]}`,
        authorIndex: author,
        body:
          `# Standup — ${m.name} (${day})\n\n` +
          `**Yesterday:** ${pick(STATUS_VERBS)} ${link()}.\n\n` +
          `**Today:** picking up ${link()} with ${pick(team).name}.\n\n` +
          `**Blockers:** waiting on review of ${link()}.\n`,
      });
    } else if (kind === 1) {
      const topic = pick(MEETING_TOPICS);
      const day = dateStr(n % 120);
      const attendees = [pick(team), pick(team), pick(team)].map((t) => t.name);
      notes.push({
        relPath: `Team Journal/Meetings/${day} ${topic}.md`,
        title: `${topic} — ${day}`,
        authorIndex: author,
        body:
          `# ${topic} — ${day}\n\n**Attendees:** ${[...new Set(attendees)].join(", ")}\n\n` +
          `## Notes\n- Reviewed ${link()}\n- Decision: proceed with ${link()}\n` +
          `- Action: ${pick(team).name} to ${pick(STATUS_VERBS)} ${link()}\n`,
      });
    } else {
      const day = dateStr(n % 60);
      notes.push({
        relPath: `Team Journal/Status/${day} update ${n}.md`,
        title: `Status update ${n}`,
        authorIndex: author,
        body:
          `# Status — ${day}\n\n` +
          `${team[author].name} ${pick(STATUS_VERBS)} ${link()} and ${pick(STATUS_VERBS)} ${link()}.\n\n` +
          `See also ${link()}.\n`,
      });
    }
    n++;
  }
  return notes;
}

/**
 * Quick-test structure: exactly 10 notes across 2 folders, with wikilinks so
 * the graph connects. Used by `--quick` for a fast sync + teammate test.
 */
export function quickNotes(team: readonly TeamMember[]): PlannedNote[] {
  const groups: Record<string, string[]> = {
    Product: ["Roadmap", "Launch Plan", "Pricing", "Metrics", "Feedback"],
    Team: ["Standup", "Hiring", "Retro", "OKRs", "Handbook"],
  };
  const notes: PlannedNote[] = [];
  let i = 0;
  for (const folder of Object.keys(groups)) {
    for (const title of groups[folder]) {
      const author = team[i % team.length];
      notes.push({
        relPath: `${folder}/${title}.md`,
        title,
        authorIndex: i % team.length,
        body:
          `# ${title}\n\nOwned by ${author.name}.\n\n` +
          `Related: [[Roadmap]] · [[Hiring]] · [[Metrics]]\n\n` +
          `- First point about ${title.toLowerCase()}\n- Second point\n- Third point\n`,
      });
      i++;
    }
  }
  return notes;
}

/**
 * Build clean index notes: one per top-level folder listing its immediate
 * children as wikilinks, plus a root vault index linking the top folders.
 */
export function buildIndexNotes(allRelPaths: readonly string[]): PlannedNote[] {
  const topLevel = new Map<string, Set<string>>(); // top folder → child titles
  const roots = new Set<string>();
  for (const rel of allRelPaths) {
    const parts = rel.split("/");
    if (parts.length < 2) continue;
    const top = parts[0];
    roots.add(top);
    if (!topLevel.has(top)) topLevel.set(top, new Set());
    // Link either the child note (if directly inside) or the child sub-folder.
    const child = parts.length === 2 ? titleFromRelPath(rel) : parts[1];
    topLevel.get(top)!.add(child);
  }

  const out: PlannedNote[] = [];
  const sortedRoots = [...roots].sort();
  for (const top of sortedRoots) {
    const children = [...(topLevel.get(top) ?? [])].sort().slice(0, 300);
    out.push({
      relPath: `${top}/_Index.md`,
      title: `${top} — Index`,
      authorIndex: 0,
      body:
        `# 📁 ${top}\n\nAuto-generated index of everything under **${top}**.\n\n` +
        children.map((c) => `- [[${c}]]`).join("\n") +
        "\n",
    });
  }
  out.push({
    relPath: `_Vault Index.md`,
    title: "Vault Index",
    authorIndex: 0,
    body:
      `# 📇 ${"Vault Index"}\n\nTop-level areas of this vault:\n\n` +
      sortedRoots.map((t) => `- [[${t} — Index]]`).join("\n") +
      "\n",
  });
  return out;
}
