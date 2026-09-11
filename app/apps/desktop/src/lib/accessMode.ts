// The one authority for "what can the team do with this item?".
//
// Two surfaces used to answer this question separately and disagree: the Access
// panel's row badges read only the lock/deny overlay and fell straight back to
// the vault's mode, so a folder explicitly set to Shared inside a Private vault
// badged "Private"; the detail pane's tri-state read the item's own share rows
// and got it right. One list, two answers, on the same screen.
//
// This mirrors `app/apps/server/src/permissions/resolver.ts` at the ORG level —
// what a plain teammate gets, before any per-user grant, lock or deny is laid
// over the top. Per-user rows stay where they were (the "Restricted" badge and
// the per-member menu): they are an overlay on this, not a replacement for it.

import { type Share, sharePrincipalType, shareResourceId } from "./api";

export type TeamMode = "open" | "readonly" | "private";

/** The org-principal share rows that can sit on a folder or note. */
export type OrgRow = "edit" | "view" | "locked" | "denied";

/**
 * The label every control on the Access page shows for a mode.
 *
 * `open` is **"Shared"**, not "Open": every button, badge and card already said
 * Shared while one hint in the detail pane said Open, which read as a fourth
 * state nobody could find.
 */
export const MODE_LABEL: Record<TeamMode, string> = {
  open: "Shared",
  readonly: "Read-only",
  private: "Private",
};

export interface EffectiveTeamModeInput {
  /** The vault-wide mode (the org grant on the vault resource). */
  vaultMode: TeamMode;
  /** Vault-relative path of the item being resolved. */
  path: string;
  /**
   * Every folder path above `path`, **root first** — exactly what
   * `accessTree.ancestorPaths` returns. Resolution walks it nearest-first.
   */
  ancestors: readonly string[];
  /** Org-principal rows by vault-relative path (the item's own path included). */
  orgRowsByPath: ReadonlyMap<string, ReadonlySet<OrgRow>>;
}

export interface EffectiveTeamMode {
  mode: TeamMode;
  /** Where the answer came from: this item, a folder above it, or the vault. */
  source: "self" | "ancestor" | "vault";
  /** The path that decided it — unset when `source` is `"vault"`. */
  sourcePath?: string;
}

/**
 * Resolve an item's team mode.
 *
 * Precedence, matching the server resolver:
 *  1. a `denied` on the item or any ancestor  → **private** (the org deny drops
 *     every org-scoped grant, vault-wide one included);
 *  2. a `locked` on the item or any ancestor  → **readonly**, but only if some
 *     grant actually reaches the item. A lock is a *cap*, never a grant: the
 *     server consults `isLocked` only once a permission has resolved above
 *     `none`, so a bare lock in a Private vault leaves the team with nothing,
 *     and calling that Read-only would be the panel disagreeing with the
 *     enforcer — the one thing this function exists to prevent;
 *  3. the vault is open, or an `edit` sits on the item/an ancestor → **open**;
 *  4. the vault is readonly, or a `view` sits on the item/an ancestor →
 *     **readonly**;
 *  5. otherwise **private** — no grant reaches it.
 */
export function effectiveTeamMode(input: EffectiveTeamModeInput): EffectiveTeamMode {
  // Nearest first: the item itself, then its folders from the inside out.
  const chain: Array<{ path: string; self: boolean }> = [
    { path: input.path, self: true },
    ...[...input.ancestors].reverse().map((path) => ({ path, self: false })),
  ];
  const nearest = (row: OrgRow) =>
    chain.find((link) => input.orgRowsByPath.get(link.path)?.has(row)) ?? null;
  const from = (
    link: { path: string; self: boolean },
    mode: TeamMode,
  ): EffectiveTeamMode => ({
    mode,
    source: link.self ? "self" : "ancestor",
    sourcePath: link.path,
  });

  const denied = nearest("denied");
  if (denied) return from(denied, "private");

  const edit = nearest("edit");
  const view = nearest("view");
  /** Does anything GRANT the team access here for a lock to cap? */
  const granted = input.vaultMode !== "private" || !!edit || !!view;

  const locked = nearest("locked");
  // With nothing granted the lock is inert and the vault's Private is the whole
  // answer, so `source` names the vault rather than a row that decides nothing.
  if (locked) return granted ? from(locked, "readonly") : { mode: "private", source: "vault" };

  // The vault is checked before the matching grant so `source` stays honest:
  // an edit grant under an already-open vault changes nothing, and pointing at
  // it would send someone to clear a row that is not what is deciding this.
  if (input.vaultMode === "open") return { mode: "open", source: "vault" };
  if (edit) return from(edit, "open");

  if (input.vaultMode === "readonly") return { mode: "readonly", source: "vault" };
  if (view) return from(view, "readonly");

  return { mode: "private", source: "vault" };
}

/**
 * Every ORG-principal row in a vault, by vault-relative path — the map
 * {@link effectiveTeamMode} resolves against.
 *
 * Two sources, unioned because they describe the same server state from
 * different angles. The team-access response names every org row including the
 * `edit`/`view` grants, which nothing else on the Access screen can see and
 * whose absence is why a folder set to Shared inside a Private vault used to
 * badge Private. The vault's lock/deny overlay keeps the badges honest against
 * a server too old to answer the first.
 *
 * Ids resolve through `entries` first — the SERVER's structure, which still
 * lists items that have left the disk — and only then through the local tree,
 * or a Private item's row would lose its path and badge as Shared.
 *
 * Per-USER rows are dropped: they are an overlay on the mode (the "Restricted"
 * badge, the per-member menu), not part of it.
 */
export function buildOrgRowsByPath(
  entries: readonly { id: string; path: string }[],
  /** id→path for anything `entries` misses — what `locks.resourceIdsByPath` returns. */
  fallbackIds: ReadonlyMap<string, string> | null,
  overrides: readonly { resourceId: string; permission: OrgRow }[] | null,
  locks: readonly Share[],
  denies: readonly Share[],
): Map<string, Set<OrgRow>> {
  const idToPath = new Map(entries.map((e) => [e.id, e.path] as const));
  for (const [id, path] of fallbackIds ?? []) {
    if (!idToPath.has(id)) idToPath.set(id, path);
  }
  const out = new Map<string, Set<OrgRow>>();
  const add = (resourceId: string, permission: OrgRow) => {
    const path = idToPath.get(resourceId);
    if (!path) return;
    const set = out.get(path) ?? new Set<OrgRow>();
    set.add(permission);
    out.set(path, set);
  };
  for (const o of overrides ?? []) add(o.resourceId, o.permission);
  for (const s of [...locks, ...denies]) {
    if (sharePrincipalType(s) !== "org") continue;
    add(shareResourceId(s), s.permission);
  }
  return out;
}

/**
 * "3 folder settings and 1 note setting" — how many per-item settings a
 * whole-vault change is about to replace. Empty string when there are none.
 */
export function overrideCountPhrase(folders: number, notes: number): string {
  const parts: string[] = [];
  if (folders > 0) parts.push(`${folders} folder setting${folders === 1 ? "" : "s"}`);
  if (notes > 0) parts.push(`${notes} note setting${notes === 1 ? "" : "s"}`);
  return parts.join(" and ");
}

/**
 * "4 folder and note settings" — what the server reports it actually cleared.
 *
 * Separate from {@link overrideCountPhrase} because the server answers with one
 * total, not a folder/note split, and the count it gives is the one worth
 * showing: a teammate can add an override between the confirm and the write.
 */
export function clearedCountPhrase(cleared: number): string {
  return cleared === 1
    ? "1 folder or note setting"
    : `${cleared} folder and note settings`;
}
