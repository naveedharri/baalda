import { pool } from "../db/pool.js";

/**
 * Bridge between the HTTP/auth layer (where a member join happens) and the vault
 * replication channel (which fans events out to connected teammates). The channel
 * is created in the process entrypoint, long after routes/auth are wired, so the
 * publisher is injected there via `setMemberJoinedPublisher`. Until then — and in
 * unit tests that never start the channel — announcing is a no-op.
 */
type MemberJoinedPublisher = (vaultId: string, name: string) => void;

let publish: MemberJoinedPublisher | null = null;

export function setMemberJoinedPublisher(fn: MemberJoinedPublisher): void {
  publish = fn;
}

/**
 * Tell everyone live in a vault that `name` just joined. Fans out to every note
 * collection the vault (organization) owns (currently one) — the `vaultId`
 * arguments below are note-collection ids, not the user-facing vault. Best-
 * effort: swallows its own errors so a failed announce can never fail the join
 * that triggered it.
 */
export async function announceMemberJoined(
  organizationId: string,
  name: string,
): Promise<void> {
  if (!publish) return;
  try {
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM vaults WHERE organization_id = $1",
      [organizationId],
    );
    for (const { id } of rows) publish(id, name);
  } catch (err) {
    console.error("announceMemberJoined failed:", err);
  }
}

/** The vault's name/icon as they stand after an update (#306). */
export type OrgChangedFields = { name?: string; logo?: string | null };
type OrgChangedPublisher = (vaultId: string, change: OrgChangedFields) => void;

let publishOrg: OrgChangedPublisher | null = null;

export function setOrgChangedPublisher(fn: OrgChangedPublisher): void {
  publishOrg = fn;
}

/**
 * Tell everyone live in a vault that its name or icon changed, so their vault
 * list updates without a reload. Same fan-out and best-effort contract as
 * {@link announceMemberJoined}.
 */
export async function announceOrgChanged(
  organizationId: string,
  change: OrgChangedFields,
): Promise<void> {
  if (!publishOrg) return;
  try {
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM vaults WHERE organization_id = $1",
      [organizationId],
    );
    for (const { id } of rows) publishOrg(id, change);
  } catch (err) {
    console.error("announceOrgChanged failed:", err);
  }
}

/** The vault's shared appearance after an owner/admin saved it. */
export type AppearanceChangedFields = {
  orgId: string;
  settings: Record<string, unknown>;
  updatedAt: string;
};
type AppearanceChangedPublisher = (vaultId: string, change: AppearanceChangedFields) => void;

let publishAppearance: AppearanceChangedPublisher | null = null;

export function setAppearanceChangedPublisher(fn: AppearanceChangedPublisher | null): void {
  publishAppearance = fn;
}

/**
 * Tell everyone live in a vault that its appearance changed, carrying the whole
 * settings object so clients apply it without a GET. Same fan-out and
 * best-effort contract as {@link announceOrgChanged}.
 */
export async function announceAppearanceChanged(change: AppearanceChangedFields): Promise<void> {
  if (!publishAppearance) return;
  try {
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM vaults WHERE organization_id = $1",
      [change.orgId],
    );
    for (const { id } of rows) publishAppearance(id, change);
  } catch (err) {
    console.error("announceAppearanceChanged failed:", err);
  }
}

/** Why a membership ended: an owner/admin removed them, or they left. */
export type MemberRemovedReason = "removed" | "left";
type MemberRemovedPublisher = (
  vaultId: string,
  orgId: string,
  userId: string,
  reason: MemberRemovedReason,
) => void;

let publishRemoved: MemberRemovedPublisher | null = null;

export function setMemberRemovedPublisher(fn: MemberRemovedPublisher | null): void {
  publishRemoved = fn;
}

/**
 * Tell `userId`'s live vault-channel connections that their membership of
 * `organizationId` ended, which also closes them. Call AFTER the member row is
 * gone, so the client's reconnect fails at the token mint. Same fan-out and
 * best-effort contract as {@link announceMemberJoined}.
 */
export async function announceMemberRemoved(
  organizationId: string,
  userId: string,
  reason: MemberRemovedReason,
): Promise<void> {
  if (!publishRemoved) return;
  try {
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM vaults WHERE organization_id = $1",
      [organizationId],
    );
    for (const { id } of rows) publishRemoved(id, organizationId, userId, reason);
  } catch (err) {
    console.error("announceMemberRemoved failed:", err);
  }
}
