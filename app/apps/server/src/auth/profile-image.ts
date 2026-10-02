// A profile picture rides on Better Auth's `user.image`. The desktop writes a
// picked character (`character:<seed>`) or a small uploaded image; a sign-in
// provider (Google) writes a photo URL. Anything else is refused, so the
// column stays small and safe to put in an <img src>. Mirrors desktop
// `lib/profileAvatar.ts`.

/** Ceiling on a stored value: a 128px picture fits with room to spare. */
export const PROFILE_IMAGE_MAX_CHARS = 96 * 1024;

const CHARACTER_RE = /^character:[A-Za-z0-9-]{1,64}$/;
const IMAGE_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;
const URL_RE = /^https?:\/\/\S{1,2040}$/;

/** null/undefined clear the picture back to the default character. */
export function isValidProfileImage(image: unknown): boolean {
  if (image === null || image === undefined) return true;
  if (typeof image !== "string" || image.length > PROFILE_IMAGE_MAX_CHARS) return false;
  return CHARACTER_RE.test(image) || IMAGE_RE.test(image) || URL_RE.test(image);
}
