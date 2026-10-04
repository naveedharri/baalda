/**
 * Who may delete what (the server's creator-only delete rule).
 *
 * A plain `member` may delete only the notes, files and folders they created;
 * `owner`/`admin` may delete anything. The server enforces it (403
 * `delete_not_creator` / `folder_has_others_items`); the desktop mirrors it so
 * the sidebar disables Delete up front and a refused disk delete is put back
 * instead of leaving the file gone on this device only.
 */
import { ApiError } from "../api";

export const NOT_CREATOR_CODES: ReadonlySet<string> = new Set([
  "delete_not_creator",
  "folder_has_others_items",
]);

/** The one sentence every surface shows for this refusal. */
export const NOT_CREATOR_MESSAGE = "Only the person who created this, or an admin, can delete it";

/** `ReconcileItem.detail` marker for a disk delete the server refused on this rule. */
export const NOT_CREATOR_DETAIL = "delete-not-creator";

export function isNotCreatorCode(code: string | null | undefined): boolean {
  return !!code && NOT_CREATOR_CODES.has(code);
}

/** The creator-rule code an error carries, or null. */
export function notCreatorCodeOf(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.status !== 403) return null;
  const body = err.body;
  const code =
    body && typeof body === "object" && "code" in body
      ? (body as { code?: unknown }).code
      : null;
  return typeof code === "string" && NOT_CREATOR_CODES.has(code) ? code : null;
}

/** Owners and admins delete anything; anyone else only what they created. */
export function roleCanDeleteAnything(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

/**
 * Whether Delete is offered for an item. An unknown role (signed out, local
 * vault, roster not loaded yet) is not gated: the server stays the authority
 * and a 403 is reported by toast.
 */
export function canDeleteItem(
  role: string | null | undefined,
  authoredByMe: () => boolean,
): boolean {
  if (!role || roleCanDeleteAnything(role)) return true;
  return authoredByMe();
}
