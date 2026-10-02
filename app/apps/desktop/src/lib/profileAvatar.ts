// A profile picture, stored on Better Auth's `user.image`. Three shapes share
// that one column:
// - absent: the generated character seeded by the person's name (the default);
// - `character:<seed>`: a character they picked from the presets below;
// - an image URL — a `data:image/…` upload, or a provider's photo (Google).
// The server validates the value (`server/src/auth/profile-image.ts`).

export const CHARACTER_PREFIX = "character:";

/** Uploaded pictures are resized to this square before they are stored. */
export const PROFILE_IMAGE_PX = 128;
/** Ceiling on a stored value; mirrored by the server's validator. */
export const PROFILE_IMAGE_MAX_CHARS = 96 * 1024;

/**
 * The characters on offer. Fixed seeds, so everyone sees the same gallery and a
 * pick renders the same character on every machine. Append only.
 */
export const PROFILE_CHARACTER_SEEDS = Array.from({ length: 24 }, (_, i) => `baalda-${i + 1}`);

/** The character seed an image value names, or null when it isn't one. */
export function characterSeed(image: string | null | undefined): string | null {
  if (!image?.startsWith(CHARACTER_PREFIX)) return null;
  const seed = image.slice(CHARACTER_PREFIX.length);
  return seed.length > 0 ? seed : null;
}
