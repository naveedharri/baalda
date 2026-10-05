// A vault's icon, like a person's character: every vault gets one by default,
// and an owner/admin can pick another preset or upload an image.
//
// Where it lives:
// - a SYNCED vault stores it on the Better Auth organization's `logo` column,
//   so the whole team sees the same icon (the server validates the value —
//   `server/src/auth/vault-icon.ts`, the same contract as `isValidVaultIcon`);
// - a LOCAL vault has no server row, so it lives in this device's
//   localStorage, keyed by folder path.
//
// Wire format (one string): `preset:<icon>:<color>` or a `data:image/…`
// URL. Absent means "the default", which is derived from the vault's identity
// so it is stable on every device without storing anything.
//
// Pure apart from the localStorage helpers; no DiceBear here — rendering the
// preset glyphs is `components/VaultIconSvg.tsx`, behind a lazy boundary.

import { ITEM_COLORS, vaultTileColor } from "./appearance";

/**
 * The presets on offer, a curated slice of DiceBear's Bootstrap icon set (its
 * `icons` style). Never reorder or remove an entry: the default icon hashes
 * into this list, so a change would re-skin every vault without its own icon.
 * Append new ones at the end.
 */
export const VAULT_ICON_NAMES = [
  "book",
  "bookshelf",
  "archive",
  "briefcase",
  "building",
  "house",
  "bank",
  "globe",
  "compass",
  "map",
  "signpost",
  "lightbulb",
  "lightning",
  "star",
  "gem",
  "trophy",
  "award",
  "heart",
  "flower1",
  "flower2",
  "tree",
  "sun",
  "moonStars",
  "cloud",
  "palette",
  "brush",
  "pen",
  "puzzle",
  "key",
  "camera",
  "controller",
  "cup",
  "megaphone",
  "newspaper",
  "mortarboard",
  "magic",
  "piggyBank",
  "boxSeam",
  "envelope",
  "bicycle",
] as const;

export type VaultIconName = (typeof VAULT_ICON_NAMES)[number];

export type PresetVaultIcon = { kind: "preset"; icon: VaultIconName; color: string };
export type VaultIcon = PresetVaultIcon | { kind: "image"; src: string };

/** The colour id for "no background": the glyph alone, in the text colour. */
export const NO_COLOR = "none";

/** Uploaded images are resized to this square before they are stored. */
export const VAULT_ICON_IMAGE_PX = 128;
/** Ceiling on a stored image data URL; mirrored by the server's validator. */
export const VAULT_ICON_MAX_CHARS = 96 * 1024;

const PRESET_RE = /^preset:([A-Za-z0-9]+):([a-z]+)$/;
const IMAGE_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;

/** Is `raw` a value the server will store? (`null` clears to the default.) */
export function isValidVaultIcon(raw: string | null): boolean {
  if (raw === null) return true;
  return parseVaultIcon(raw) !== null;
}

/** The stored string → an icon, or null when absent or unrecognised. */
export function parseVaultIcon(raw: string | null | undefined): VaultIcon | null {
  if (!raw) return null;
  const preset = PRESET_RE.exec(raw);
  if (preset) {
    const [, icon, color] = preset;
    if (!(VAULT_ICON_NAMES as readonly string[]).includes(icon)) return null;
    if (color !== NO_COLOR && !ITEM_COLORS.some((c) => c.id === color)) return null;
    return { kind: "preset", icon: icon as VaultIconName, color };
  }
  if (raw.length <= VAULT_ICON_MAX_CHARS && IMAGE_RE.test(raw)) return { kind: "image", src: raw };
  return null;
}

export function serializeVaultIcon(icon: VaultIcon): string {
  return icon.kind === "preset" ? `preset:${icon.icon}:${icon.color}` : icon.src;
}

/** FNV-1a, the same family `appearance.ts` hashes colours with. */
function hash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The icon a vault has until someone picks one. `identity` is the switcher's
 * row key (`org:<id>` / `local:<path>`), so a synced vault's default is the
 * same on every teammate's machine.
 */
export function defaultVaultIcon(identity: string): PresetVaultIcon {
  return {
    kind: "preset",
    icon: VAULT_ICON_NAMES[hash(`icon\0${identity}`) % VAULT_ICON_NAMES.length],
    color: vaultTileColor(identity).id,
  };
}

/** What a vault shows: its chosen icon, else its default. */
export function resolveVaultIcon(identity: string, raw: string | null | undefined): VaultIcon {
  return parseVaultIcon(raw) ?? defaultVaultIcon(identity);
}

// ---- Local vaults: device-local storage ----

const LOCAL_PREFIX = "context.vaultIcon:";
const CHANGE_EVENT = "context:vault-icon-changed";

export function readLocalVaultIcon(path: string): string | null {
  try {
    return localStorage.getItem(LOCAL_PREFIX + path);
  } catch {
    return null;
  }
}

export function writeLocalVaultIcon(path: string, raw: string | null): void {
  try {
    if (raw === null) localStorage.removeItem(LOCAL_PREFIX + path);
    else localStorage.setItem(LOCAL_PREFIX + path, raw);
  } catch {
    // Storage unavailable: the icon just doesn't persist on this device.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/**
 * A member's own icon for a SYNCED vault (#291): stored on this device only,
 * never on the organization, and preferred over the team's icon when painting
 * the switcher. Shares the local store (and its change event) with local vaults,
 * under a key no folder path can take.
 */
export function readPersonalVaultIcon(orgId: string): string | null {
  return readLocalVaultIcon(`org:${orgId}`);
}

export function writePersonalVaultIcon(orgId: string, raw: string | null): void {
  writeLocalVaultIcon(`org:${orgId}`, raw);
}

// ---- Recent uploads: device-local, offered again in the picker ----

const RECENT_KEY = "context.vaultIcon.recentUploads";
/** How many uploaded images the picker remembers. */
export const RECENT_UPLOADS_MAX = 8;

/** Uploaded icons this device used, newest first. */
export function readRecentUploads(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(raw)
      ? raw.filter((v): v is string => typeof v === "string" && parseVaultIcon(v)?.kind === "image")
      : [];
  } catch {
    return [];
  }
}

/** Put `src` at the front of the recent uploads (deduped, capped). */
export function rememberRecentUpload(src: string): void {
  if (parseVaultIcon(src)?.kind !== "image") return;
  const next = [src, ...readRecentUploads().filter((v) => v !== src)].slice(0, RECENT_UPLOADS_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Storage full or unavailable: the list just isn't remembered.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Subscribe to local-icon changes made anywhere in this window. */
export function onLocalVaultIconChange(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}
