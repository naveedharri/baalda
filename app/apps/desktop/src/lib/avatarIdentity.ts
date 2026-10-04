// The ONE rule for what face a person gets, shared by every surface that draws
// an avatar (account bar, presence stack and roster, sidebar presence, version
// rows, Members and access, member profile, share list, account settings).
//
// 1. Their stored picture wins: a picked character (`character:<seed>`) or a
//    photo URL (`user.image`, see `profileAvatar.ts`).
// 2. Otherwise the generated character is seeded by their USER ID — stable
//    across devices, sessions and renames, and present on every surface
//    (session, awareness `user.id`, vault-channel `userId`, version authorId,
//    member rows). The display name is only the seed of last resort, for a
//    payload from a peer on an older build that carries no id.
//
// Pure and dependency-free (no DiceBear), so eager modules may import it.
import { useSyncExternalStore } from "react";
import { characterSeed } from "./profileAvatar";

export interface AvatarIdentity {
  userId?: string | null;
  name?: string | null;
  image?: string | null;
}

export interface ResolvedAvatar {
  /** A photo URL to show, or null for the generated character. */
  photo: string | null;
  /** The generated character's seed (used when there is no photo, or it fails). */
  seed: string;
}

/** Seed and photo for a person, applying the rule above. */
export function resolveAvatar({ userId, name, image }: AvatarIdentity): ResolvedAvatar {
  const picked = characterSeed(image);
  const fallback = (userId && userId.trim()) || (name && name.trim()) || "?";
  return {
    photo: !picked && image ? image : null,
    seed: picked ?? fallback,
  };
}

/** Longest picture value we put on a presence wire (awareness). A `data:` upload
 *  is up to 96 KB and would be rebroadcast on every heartbeat, so it stays off. */
const WIRE_IMAGE_MAX = 512;

/** The part of `user.image` that is cheap enough to broadcast with presence. */
export function wireAvatarImage(image: string | null | undefined): string | undefined {
  if (!image || image.length > WIRE_IMAGE_MAX) return undefined;
  if (characterSeed(image)) return image;
  return /^https?:\/\//i.test(image) ? image : undefined;
}

// ---- who has which picture --------------------------------------------------
// A process-wide userId → image directory, fed by every response that carries a
// picture (the signed-in session, the members overview, presence payloads), so
// surfaces whose own payload has only an id or a name still draw the same face.

const images = new Map<string, string | null>();
const listeners = new Set<() => void>();
let version = 0;

/** Record what picture a user has (null = none). No-op when unchanged. */
export function rememberAvatarImage(userId: string | null | undefined, image: string | null | undefined): void {
  if (!userId || image === undefined) return;
  const next = image || null;
  if (images.has(userId) && images.get(userId) === next) return;
  images.set(userId, next);
  version++;
  for (const l of listeners) l();
}

/** The last known picture for a user, or undefined when nothing is known. */
export function knownAvatarImage(userId: string | null | undefined): string | null | undefined {
  return userId ? images.get(userId) : undefined;
}

/** Test seam: forget every remembered picture. */
export function resetAvatarImages(): void {
  images.clear();
  version++;
  for (const l of listeners) l();
}

const getVersion = () => version;

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Resolve a person's avatar, filling a missing `image` from the directory and
 *  re-rendering when the directory learns their picture. */
export function useResolvedAvatar(identity: AvatarIdentity): ResolvedAvatar {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  const image = identity.image !== undefined ? identity.image : knownAvatarImage(identity.userId);
  return resolveAvatar({ ...identity, image });
}

// ---- what this device broadcasts about itself --------------------------------

let selfImage: string | undefined;

/** Set the signed-in user's picture for presence payloads (`presenceUser`). */
export function setSelfAvatarImage(userId: string | null | undefined, image: string | null | undefined): void {
  selfImage = wireAvatarImage(image);
  rememberAvatarImage(userId, image ?? null);
}

/** The signed-in user's broadcastable picture, if any. */
export function selfAvatarImage(): string | undefined {
  return selfImage;
}
