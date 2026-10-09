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
}

/** The two text lines of a vault card. Every card has the same shape, so
    there is no optional slug line: the slug lives on the vault's page. */
export function vaultCardLabels(
  org: { name: string },
  usage: { people: number; notes: number } | null,
): VaultCardLabels {
  return {
    name: org.name,
    counts: usage
      ? `${plural(usage.people, "person", "people")} · ${plural(usage.notes, "note", "notes")}`
      : null,
  };
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
