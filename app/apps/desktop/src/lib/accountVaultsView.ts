/* Account Settings → Vaults: how the "Synced vaults" section is laid out
   (rows or cards), remembered per device, plus the text a vault card shows. */

export type AccountVaultsView = "list" | "grid";
export const ACCOUNT_VAULTS_VIEW_KEY = "context.accountVaults.view";

/** The stored view. Grid is the default; only an explicit stored "list" is the list. */
export function readAccountVaultsView(): AccountVaultsView {
  try {
    return localStorage.getItem(ACCOUNT_VAULTS_VIEW_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

export function writeAccountVaultsView(view: AccountVaultsView): void {
  try {
    localStorage.setItem(ACCOUNT_VAULTS_VIEW_KEY, view);
  } catch {
    /* storage unavailable */
  }
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export interface VaultCardLabels {
  name: string;
  /** "1 person · 21 notes", or null when the counts are not known. */
  counts: string | null;
  /** The details line: the counts, else "Folder missing" for a card whose
      folder is gone, else null (the line still renders, empty). */
  meta: string | null;
  /** The details line is the folder-missing warning (danger colour). */
  metaDanger: boolean;
}

/** The card's details line when its folder is gone and no counts are known. */
export const CARD_FOLDER_MISSING = "Folder missing";

/** The two text lines of a vault card. Every card has the same shape, so
    there is no optional slug line: the slug lives on the vault's page. */
export function vaultCardLabels(
  org: { name: string },
  usage: { people: number; notes: number } | null,
  opts: { folderMissing?: boolean } = {},
): VaultCardLabels {
  const counts = usage
    ? `${plural(usage.people, "person", "people")} · ${plural(usage.notes, "note", "notes")}`
    : null;
  const metaDanger = !counts && !!opts.folderMissing;
  return {
    name: org.name,
    counts,
    meta: counts ?? (metaDanger ? CARD_FOLDER_MISSING : null),
    metaDanger,
  };
}

/**
 * A card whose folder is missing keeps its shape: ONE recovery chip in the
 * foot row (two do not fit beside each other at the card's minimum width), and
 * the other action moves into the card's ⋯ menu. A synced vault leads with
 * Restore here; a local-only one has Locate folder… alone.
 */
export function folderMissingCardActions(synced: boolean): {
  chip: "restore" | "locate";
  menu: Array<"locate">;
} {
  return synced ? { chip: "restore", menu: ["locate"] } : { chip: "locate", menu: [] };
}

/** The slug the vault page shows, or null when it has none or it only repeats the name. */
export function vaultSlugLabel(org: { name: string; slug?: string | null }): string | null {
  const slug = org.slug?.trim() || null;
  return slug && slug.toLowerCase() !== org.name.trim().toLowerCase() ? slug : null;
}

export interface LocalCardLabels {
  name: string;
  /** "Local", or "Local · <folder>" when the folder's name differs from the vault's. */
  meta: string;
  /** The letter the row's swatch shows. */
  letter: string;
}

/** The lines of a local-folder card in grid view. */
export function localCardLabels(row: { name: string; path: string }): LocalCardLabels {
  const segment = row.path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  const differs = segment !== "" && segment.toLowerCase() !== row.name.trim().toLowerCase();
  return {
    name: row.name,
    meta: differs ? `Local · ${segment}` : "Local",
    letter: Array.from(row.name.trim())[0]?.toUpperCase() ?? "?",
  };
}

// ---- The Vaults page as cards (2026-11-20) --------------------------------

/** How many synced vaults the page shows before "Show all": two rows of four. */
export const RECENT_VAULT_CARDS = 8;

/** Which vaults the page lists. */
export type VaultsScope = "all" | "synced" | "local";

/**
 * Synced vaults in card order: the open one first, then by when this device
 * last opened each (via its bound folder), then the ones never opened here,
 * by name. The same recency the vault switcher uses (`lib/vaultRows.ts`).
 */
export function orderSyncedVaults<T extends { id: string; name: string }>(
  orgs: readonly T[],
  opts: { openOrgId: string | null; openedAtByOrg: Readonly<Record<string, number>> },
): T[] {
  return [...orgs].sort(
    (a, b) =>
      Number(b.id === opts.openOrgId) - Number(a.id === opts.openOrgId) ||
      (opts.openedAtByOrg[b.id] ?? 0) - (opts.openedAtByOrg[a.id] ?? 0) ||
      a.name.localeCompare(b.name),
  );
}

/** Lower-cased, trimmed search; "" matches everything. */
export function matchesVaultQuery(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || name.toLowerCase().includes(q);
}

/**
 * The synced cards to draw: every match while searching, else the first
 * {@link RECENT_VAULT_CARDS} unless the list is expanded. `hidden` is how many
 * the cut left out (0 when nothing was cut).
 */
export function visibleSyncedVaults<T extends { name: string }>(
  ordered: readonly T[],
  opts: { query: string; showAll: boolean },
): { shown: T[]; hidden: number } {
  const matches = ordered.filter((o) => matchesVaultQuery(o.name, opts.query));
  if (opts.query.trim() !== "" || opts.showAll || matches.length <= RECENT_VAULT_CARDS) {
    return { shown: matches, hidden: 0 };
  }
  return { shown: matches.slice(0, RECENT_VAULT_CARDS), hidden: matches.length - RECENT_VAULT_CARDS };
}

/** One piece of a card's second line; `tone` picks its colour/icon. */
export interface CardMetaPart {
  text: string;
  tone?: "open" | "cloud" | "danger";
}

const ROLE_LABEL: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member" };

/**
 * A synced vault card's second line, as parts joined by " · ". Every part is
 * something we actually know; an unknown one is left out, never guessed:
 * "Open now" for the open vault; the caller's role when the server told us
 * (the open vault's member list, or the billing listing); then ONE detail:
 * the folder is missing, it has never been opened here, its people/notes
 * counts (vaults on this account), or whose vault it is.
 */
export function syncedCardMeta(input: {
  isOpen: boolean;
  role: string | null;
  onDevice: boolean;
  folderMissing: boolean;
  usage: { people: number; notes: number } | null;
  ownerName: string | null;
}): CardMetaPart[] {
  const parts: CardMetaPart[] = [];
  if (input.isOpen) parts.push({ text: "Open now", tone: "open" });
  const role = input.role ? ROLE_LABEL[input.role] ?? null : null;
  if (role) parts.push({ text: role });
  if (input.folderMissing) parts.push({ text: CARD_FOLDER_MISSING, tone: "danger" });
  else if (!input.onDevice) parts.push({ text: "Not on this device", tone: "cloud" });
  else if (input.usage) {
    parts.push({
      text: `${plural(input.usage.people, "person", "people")} · ${plural(input.usage.notes, "note", "notes")}`,
    });
  } else if (input.ownerName && input.role !== "owner") {
    parts.push({ text: `${input.ownerName}’s vault` });
  }
  return parts;
}

/** "…/Documents/Baalda Vaults" → "Documents › Baalda Vaults": the last two
 *  segments, for a card or the root line (the full path is the tooltip). */
export function shortFolderPath(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join(" › ") || path;
}
