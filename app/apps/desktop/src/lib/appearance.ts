// Per-item accent colors for folders and notes, applied to the tree glyphs.
//
// On a SYNCED vault the color lives on the server row (`folders.color` /
// `notes.color`) and arrives with the registry pull, so a folder you tint is
// tinted for the whole team on every machine. localStorage is still written
// underneath as the offline mirror and as the whole story for a local vault —
// keyed by vault-relative path, which is all a local vault has.

export interface ItemColor {
  id: string;
  label: string;
  /** Glyph tint — reads on both themes against the sidebar surfaces. */
  value: string;
}

export const ITEM_COLORS: ItemColor[] = [
  { id: "violet", label: "Violet", value: "#7c5cff" },
  { id: "blue", label: "Blue", value: "#2f7de1" },
  { id: "teal", label: "Teal", value: "#0d9488" },
  { id: "green", label: "Green", value: "#3f9d54" },
  { id: "amber", label: "Amber", value: "#d99114" },
  { id: "orange", label: "Orange", value: "#e0702f" },
  { id: "rose", label: "Rose", value: "#d94f77" },
  { id: "slate", label: "Slate", value: "#64748b" },
];

export function itemColorValue(id: string | undefined): string | undefined {
  return ITEM_COLORS.find((c) => c.id === id)?.value;
}

const STORE_PREFIX = "context.itemColors:";

export function readItemColors(vaultPath: string | undefined): Record<string, string> {
  if (!vaultPath) return {};
  try {
    return JSON.parse(localStorage.getItem(STORE_PREFIX + vaultPath) ?? "{}") as Record<
      string,
      string
    >;
  } catch {
    return {};
  }
}

export function writeItemColors(vaultPath: string, colors: Record<string, string>): void {
  try {
    localStorage.setItem(STORE_PREFIX + vaultPath, JSON.stringify(colors));
  } catch {
    /* quota/unavailable — colors are a convenience only */
  }
}

/**
 * Have this vault's pre-sync local colors been handed to the server yet?
 *
 * Colors were a per-machine preference before they synced. The first pull after
 * a vault gains sync pushes whatever is in localStorage up, once — the flag is
 * what stops a color a teammate deliberately CLEARED from being re-uploaded by
 * this machine on every subsequent pull.
 */
const ADOPTED_PREFIX = "context.itemColors.adopted:";

export function colorsAdopted(vaultPath: string): boolean {
  try {
    return localStorage.getItem(ADOPTED_PREFIX + vaultPath) === "1";
  } catch {
    return true; // no storage → never try to adopt
  }
}

export function markColorsAdopted(vaultPath: string): void {
  try {
    localStorage.setItem(ADOPTED_PREFIX + vaultPath, "1");
  } catch {
    /* quota/unavailable — worst case we re-adopt next launch */
  }
}
