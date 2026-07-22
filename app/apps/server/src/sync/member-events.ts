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
