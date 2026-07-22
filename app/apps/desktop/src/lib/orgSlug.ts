// Vault (organization) identity is the unique org **id**; display names may
// repeat. Better Auth keys organizations by a unique `slug`, which we derive
// from the name — so two vaults named the same would collide on the slug.
// `createWithUniqueSlug` resolves that by retrying with a short random suffix on
// a slug collision, keeping the clean slug when it's free. Kept dependency-free
// (only `ApiError`/types) so it's unit-testable without the store or IPC.

import { ApiError, type Organization } from "./api";

export function slugifyName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "vault";
}

/** A short random slug suffix (base36) used to break slug collisions. */
export function slugSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
}

/** True when an org-create error is a slug-uniqueness collision (retryable). */
export function isSlugConflict(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false;
  if (e.status !== 400 && e.status !== 409 && e.status !== 422) return false;
  const hay = `${e.message} ${JSON.stringify(e.body ?? "")}`.toLowerCase();
  return (
    hay.includes("slug") ||
    hay.includes("exist") ||
    hay.includes("taken") ||
    hay.includes("unique") ||
    hay.includes("duplicate")
  );
}

/**
 * Create a vault whose display name may duplicate an existing one. Tries the
 * clean slug first; on a slug collision, retries with `<slug>-<suffix>` so the
 * create still succeeds (the org's unique identity remains its id).
 *
 * @param create  the raw create call (e.g. `api.createOrganization`)
 * @param suffix  injectable suffix generator (deterministic in tests)
 */
export async function createWithUniqueSlug(
  name: string,
  create: (input: { name: string; slug: string }) => Promise<Organization>,
  suffix: () => string = slugSuffix,
): Promise<Organization> {
  const base = slugifyName(name);
  for (let attempt = 0; attempt < 6; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${suffix()}`;
    try {
      return await create({ name, slug });
    } catch (e) {
      if (attempt < 5 && isSlugConflict(e)) continue;
      throw e;
    }
  }
  // Unreachable (the loop either returns or throws), but keeps types honest.
  throw new ApiError(409, "Could not find an available vault URL");
}
