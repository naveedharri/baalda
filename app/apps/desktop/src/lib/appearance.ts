import type { TreeNode } from "./ipc";
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
  /** The deeper tone: the glyph's outline, and the swatch in the picker. */
  value: string;
  /** The pastel the glyph is filled with (baalda.com's `*-2` swatches). */
  fill: string;
  /** Nearby hues that should not form an adjacent automatic-colour batch. */
  family: string;
}

// baalda.com's pairing: a bright pastel fill (its blue-2 #9ed4ef, green-2
// #9bd8a9, purple-2 #b8caf5, yellow-2 #fde99b, peach #f7d9be, violet #cbbcf6)
// under a deeper outline of the same hue (green-4 #3f8850, yellow-4 #987e1b,
// violet #7c5cff); the other hues are built the same way. The ids are what is
// persisted, so values can be retuned freely; never rename or reorder an id —
// the automatic assignment hashes into this list.
export const ITEM_COLORS: ItemColor[] = [
  { id: "violet", label: "Violet", value: "#7c5cff", fill: "#cbbcf6", family: "purple" },
  { id: "purple", label: "Purple", value: "#9a5fd6", fill: "#dcc2f2", family: "purple" },
  { id: "plum", label: "Plum", value: "#b0529f", fill: "#ecc0e4", family: "purple" },
  { id: "magenta", label: "Magenta", value: "#cf3f8e", fill: "#f6bcdb", family: "pink" },
  { id: "pink", label: "Pink", value: "#dc5f97", fill: "#fac6dc", family: "pink" },
  { id: "rose", label: "Rose", value: "#d4567a", fill: "#f7c2cd", family: "pink" },
  { id: "red", label: "Red", value: "#d24d43", fill: "#f7c4bd", family: "red" },
  { id: "coral", label: "Coral", value: "#dc6e52", fill: "#f9cdbf", family: "red" },
  { id: "orange", label: "Orange", value: "#d9773a", fill: "#f7d9be", family: "warm" },
  { id: "amber", label: "Amber", value: "#c98a12", fill: "#fbe1a6", family: "warm" },
  { id: "gold", label: "Gold", value: "#987e1b", fill: "#fde99b", family: "warm" },
  { id: "lime", label: "Lime", value: "#6f9a2c", fill: "#d6eba9", family: "green" },
  { id: "green", label: "Green", value: "#3f8850", fill: "#9bd8a9", family: "green" },
  { id: "mint", label: "Mint", value: "#2f9a6e", fill: "#b4e6cf", family: "green" },
  { id: "teal", label: "Teal", value: "#23877e", fill: "#a8e0d8", family: "teal" },
  { id: "cyan", label: "Cyan", value: "#1f8aa6", fill: "#a8e2ee", family: "teal" },
  { id: "sky", label: "Sky", value: "#2f86bf", fill: "#9ed4ef", family: "blue" },
  { id: "blue", label: "Blue", value: "#3b74d1", fill: "#b8d2f8", family: "blue" },
  { id: "indigo", label: "Indigo", value: "#5262d0", fill: "#b8caf5", family: "indigo" },
  { id: "periwinkle", label: "Periwinkle", value: "#6c74d4", fill: "#c9cdf6", family: "indigo" },
  { id: "brown", label: "Brown", value: "#8e6347", fill: "#e6cdb9", family: "brown" },
  { id: "slate", label: "Slate", value: "#5f6b7a", fill: "#cfd6df", family: "slate" },
];

export function itemColorValue(id: string | undefined): string | undefined {
  return ITEM_COLORS.find((c) => c.id === id)?.value;
}

export function itemColorFill(id: string | undefined): string | undefined {
  return ITEM_COLORS.find((c) => c.id === id)?.fill;
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

/** A vault's tile in the switcher: stable per vault, nothing persisted. */
export function vaultTileColor(identity: string): ItemColor {
  return ITEM_COLORS[colorHash(identity) % ITEM_COLORS.length];
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
      // Redesign: a short set of clearly different hues, still chosen by the
      // item's own identity so a folder keeps its colour when siblings are
      // added, removed or renamed. A clash with the two rows above steps on
      // through the set rather than repeating a hue.
      const start = colorHash(`${userId}\0${vaultIdentity}\0${item.identity}`) % REDESIGN_ORDER.length;
      let pick = REDESIGN_ORDER[start];
      for (let tries = 1; tries < REDESIGN_ORDER.length && recentFamilies.includes(familyOf(pick)); tries++) {
        pick = REDESIGN_ORDER[(start + tries) % REDESIGN_ORDER.length];
      }
      result[item.key] = pick;
      recentFamilies.push(familyOf(pick));
      if (recentFamilies.length > 2) recentFamilies.shift();
      continue;
    }
    result[item.key] = colorId!;
    recentFamilies.push(ITEM_COLORS.find((color) => color.id === colorId)!.family);
    if (recentFamilies.length > 2) recentFamilies.shift();
  }

  return result;
}

const REDESIGN_ORDER = ["red", "green", "gold", "sky", "violet", "pink", "teal", "orange"];
function familyOf(id: string): string {
  return ITEM_COLORS.find((color) => color.id === id)?.family ?? id;
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

/** Shared sidebar glyph colours, assigned per sibling group. */
export function automaticTreeColors(userId: string, vaultIdentity: string, siblings: TreeNode[], docIds: Record<string, string>, explicit: Record<string, string>): Record<string, string> {
  const assigned: Record<string, string> = {};
  const walk = (nodes: TreeNode[]) => {
    Object.assign(assigned, automaticItemColorAssignments(userId, vaultIdentity, nodes.filter((n) => n.isDir).map((n) => ({ key: n.path, identity: docIds[n.path] ?? n.path, explicitColorId: explicit[n.path] }))));
    for (const node of nodes) if (node.children) walk(node.children);
  };
  walk(siblings);
  return assigned;
}
