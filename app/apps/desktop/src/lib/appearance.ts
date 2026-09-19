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
  /** Nearby hues that should not form an adjacent automatic-colour batch. */
  family: string;
}

export const ITEM_COLORS: ItemColor[] = [
  { id: "violet", label: "Violet", value: "#7c5cff", family: "purple" },
  { id: "purple", label: "Purple", value: "#9b51d0", family: "purple" },
  { id: "plum", label: "Plum", value: "#b44aa1", family: "purple" },
  { id: "magenta", label: "Magenta", value: "#d13b8f", family: "pink" },
  { id: "pink", label: "Pink", value: "#e35f9b", family: "pink" },
  { id: "rose", label: "Rose", value: "#d94f77", family: "pink" },
  { id: "red", label: "Red", value: "#d84a4a", family: "red" },
  { id: "coral", label: "Coral", value: "#e26755", family: "red" },
  { id: "orange", label: "Orange", value: "#e0702f", family: "warm" },
  { id: "amber", label: "Amber", value: "#d99114", family: "warm" },
  { id: "gold", label: "Gold", value: "#bfa01d", family: "warm" },
  { id: "lime", label: "Lime", value: "#79a83b", family: "green" },
  { id: "green", label: "Green", value: "#3f9d54", family: "green" },
  { id: "mint", label: "Mint", value: "#2eaa78", family: "green" },
  { id: "teal", label: "Teal", value: "#0d9488", family: "teal" },
  { id: "cyan", label: "Cyan", value: "#1599b8", family: "teal" },
  { id: "sky", label: "Sky", value: "#398fcf", family: "blue" },
  { id: "blue", label: "Blue", value: "#2f7de1", family: "blue" },
  { id: "indigo", label: "Indigo", value: "#5868d9", family: "indigo" },
  { id: "periwinkle", label: "Periwinkle", value: "#747bd8", family: "indigo" },
  { id: "brown", label: "Brown", value: "#9a6b4f", family: "brown" },
  { id: "slate", label: "Slate", value: "#64748b", family: "slate" },
];

export function itemColorValue(id: string | undefined): string | undefined {
  return ITEM_COLORS.find((c) => c.id === id)?.value;
}

/** Stable FNV-1a hash: random-looking palette choices without persisted rows. */
function colorHash(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * The personal automatic colour for an item. Existing explicit colours stay
 * authoritative; callers use this only as the fallback for an uncoloured row.
 */
export function automaticItemColorId(
  userId: string,
  vaultIdentity: string,
  itemIdentity: string,
): string {
  return ITEM_COLORS[colorHash(`${userId}\0${vaultIdentity}\0${itemIdentity}`) % ITEM_COLORS.length].id;
}

export interface AutomaticColorItem {
  /** Stable lookup key, normally the vault-relative path. */
  key: string;
  /** Stable item identity: doc id where one exists, otherwise the path. */
  identity: string;
  /** A shared/manual colour. It always wins and informs its neighbours. */
  explicitColorId?: string;
}

/**
 * Assign one ordered group of siblings. Most rows retain their identity hash;
 * only a collision with either of the two rows immediately before it advances
 * through the palette. That prevents visible same-colour batches without
 * turning colour into a fragile function of the row's numeric position.
 */
export function automaticItemColorAssignments(
  userId: string,
  vaultIdentity: string,
  items: ReadonlyArray<AutomaticColorItem>,
): Record<string, string> {
  const result: Record<string, string> = {};
  const recentFamilies: string[] = [];

  for (const item of items) {
    let colorId = item.explicitColorId;
    if (!itemColorValue(colorId)) {
      const preferred = automaticItemColorId(userId, vaultIdentity, item.identity);
      const start = ITEM_COLORS.findIndex((color) => color.id === preferred);
      colorId = preferred;
      for (let offset = 0; offset < ITEM_COLORS.length; offset++) {
        // Seven is coprime with the 22-entry palette and jumps between hue
        // families instead of resolving a pink collision with another pink.
        const index = (start + 7 * offset) % ITEM_COLORS.length;
        const candidate = ITEM_COLORS[index].id;
        if (!recentFamilies.includes(ITEM_COLORS[index].family)) {
          colorId = candidate;
          break;
        }
      }
    }
    result[item.key] = colorId!;
    recentFamilies.push(ITEM_COLORS.find((color) => color.id === colorId)!.family);
    if (recentFamilies.length > 2) recentFamilies.shift();
  }

  return result;
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
