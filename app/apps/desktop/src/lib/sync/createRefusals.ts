// Create refusals the server will repeat until access changes.
//
// A note written into the vault folder by a script or a scheduled AI task has
// to be REGISTERED before anything about it syncs. When the server refuses that
// create for an access reason (`no_write_access`: the folder is view-only,
// locked or Private for this user; `root_frozen`: the vault's top level takes
// no new items), edits to notes that already exist keep syncing — so nothing
// looks wrong while every new file stays on this computer. This module is the
// one place those refusals are grouped (by kind + folder) for the banner and
// for Health, so the two always tell the same story.
//
// Pure and structural, like `lib/health/model.ts`: no value imports from the
// sync layer.

/** The codes held as "needs access, not luck" (see `VaultRegistry.recordFailure`). */
export const HELD_CREATE_CODES = ["no_write_access", "root_frozen"] as const;
export type HeldCreateCode = (typeof HELD_CREATE_CODES)[number];

export function isHeldCreateCode(code: string | null | undefined): code is HeldCreateCode {
  return code === "no_write_access" || code === "root_frozen";
}

/** The shape this needs out of `RegistryFailure` / `HealthRegistryFailure`. */
export interface CreateRefusalInput {
  kind: string;
  path: string;
  code: string | null;
}

export interface CreateRefusalGroup {
  code: HeldCreateCode;
  /** Vault-relative folder the items were refused in; "" is the top level. */
  folder: string;
  /** Refused paths, sorted. */
  paths: string[];
  /** How many of `paths` are notes (the rest are folders). */
  notes: number;
}

function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/**
 * One group per (code, folder), largest first, then by folder. Only note and
 * folder registrations count — a materialize or inbound failure is a different
 * problem with its own row.
 */
export function groupCreateRefusals(failures: readonly CreateRefusalInput[]): CreateRefusalGroup[] {
  const groups = new Map<string, CreateRefusalGroup>();
  const seen = new Set<string>();
  for (const f of failures) {
    if (f.kind !== "note" && f.kind !== "folder") continue;
    if (!isHeldCreateCode(f.code)) continue;
    const dedupe = `${f.code}\u0000${f.path.toLowerCase()}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    // A frozen root only ever refuses top-level items.
    const folder = f.code === "root_frozen" ? "" : parentDir(f.path);
    const key = `${f.code}\u0000${folder.toLowerCase()}`;
    let g = groups.get(key);
    if (!g) {
      g = { code: f.code, folder, paths: [], notes: 0 };
      groups.set(key, g);
    }
    g.paths.push(f.path);
    if (f.kind === "note") g.notes++;
  }
  const out = [...groups.values()];
  for (const g of out) g.paths.sort();
  out.sort((a, b) => b.paths.length - a.paths.length || a.folder.localeCompare(b.folder));
  return out;
}

/** "in Projects/Q3" / "at the top of this vault". */
export function wherePhrase(folder: string): string {
  return folder === "" ? "at the top of this vault" : `in ${folder}`;
}

function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * The banner's sentence, or null when there is nothing to say. Plain words: how
 * many, where, and what to do about it.
 */
export function createRefusalBannerText(groups: readonly CreateRefusalGroup[]): {
  lead: string;
  detail: string;
} | null {
  if (groups.length === 0) return null;
  const total = groups.reduce((n, g) => n + g.paths.length, 0);
  const items = groups.every((g) => g.notes === g.paths.length)
    ? count(total, "new note")
    : count(total, "new item");
  const lead = `${items} on this computer ${total === 1 ? "isn't" : "aren't"} syncing.`;
  const access = groups.filter((g) => g.code === "no_write_access");
  const frozen = groups.some((g) => g.code === "root_frozen");
  const parts: string[] = [];
  if (access.length === 1) {
    parts.push(
      `You don't have permission to add notes ${wherePhrase(access[0].folder)}. ` +
        "Ask an owner to give you edit access.",
    );
  } else if (access.length > 1) {
    parts.push(
      `You don't have permission to add notes in ${access.length} places. ` +
        "Ask an owner to give you edit access.",
    );
  }
  if (frozen) {
    parts.push("New notes can't be added at the top of this vault. Move them into a folder.");
  }
  return { lead, detail: parts.join(" ") };
}
