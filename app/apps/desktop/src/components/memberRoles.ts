/**
 * Who may do what to whom in the members list. Pure — mirrors the server's
 * authz matrix (orgs.ts remove + role-change handlers) so the UI only offers
 * actions that would actually succeed:
 *
 *   - owner: may change/remove any admin or member, never themselves or
 *     another owner;
 *   - admin: may change/remove plain members only (promoting one to admin is
 *     allowed — admins can already invite admins), never another admin;
 *   - member: nothing.
 *
 * `owner` is never assignable — ownership transfer is a separate, deliberate
 * operation the product doesn't support yet.
 */

export const ASSIGNABLE_ROLES = ["member", "admin"] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export interface MemberRoleArgs {
  canManage: boolean;
  myUserId: string | undefined;
  myRole: string | undefined;
  target: { userId: string; role: string };
}

/** The single predicate both actions share: may the caller act on this row? */
export function canActOnMember({ canManage, myUserId, myRole, target }: MemberRoleArgs): boolean {
  return (
    canManage &&
    target.userId !== myUserId &&
    target.role !== "owner" &&
    (myRole === "owner" || target.role === "member")
  );
}

/** Roles the caller may set on this member; empty ⇒ show a static badge. */
export function assignableRoles(args: MemberRoleArgs): AssignableRole[] {
  return canActOnMember(args) ? [...ASSIGNABLE_ROLES] : [];
}
