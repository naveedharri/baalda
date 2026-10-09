import { pool } from "../db/pool.js";
import type { PubSub } from "./pubsub.js";

/**
 * Events addressed to a USER rather than a vault. The vault channel is per
 * vault, and an invitee is not a member of the vault that invited them, so a
 * vault topic never reaches them. Every authenticated vault-channel connection
 * whose client advertises the `invitations` cap also subscribes to its user's
 * topic (`user:{userId}`), whatever vault it is for, so an event published here
 * reaches every device the user has a channel open on. The topic rides the same
 * pub/sub as vault fan-out (in-memory, or Redis across instances).
 *
 * Old desktops never advertise the cap, so they never see these frames.
 */
export type UserEvent =
  | {
      t: "invitation";
      invitationId: string;
      orgId: string;
      orgName: string;
      inviterName: string;
      role: string;
    }
  | { t: "invitation-gone"; invitationId: string };

/** The hello cap that opts a connection into user-addressed events. */
export const USER_EVENTS_CAP = "invitations";

export function userTopic(userId: string): string {
  return `user:${userId}`;
}

export function encodeUserEvent(event: UserEvent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(event));
}

export function decodeUserEvent(payload: Uint8Array): UserEvent | null {
  try {
    const v = JSON.parse(new TextDecoder().decode(payload)) as Partial<UserEvent>;
    if (v.t === "invitation-gone" && typeof v.invitationId === "string") {
      return { t: "invitation-gone", invitationId: v.invitationId };
    }
    if (v.t === "invitation" && typeof v.invitationId === "string" && typeof v.orgId === "string") {
      return {
        t: "invitation",
        invitationId: v.invitationId,
        orgId: v.orgId,
        orgName: typeof v.orgName === "string" ? v.orgName : "",
        inviterName: typeof v.inviterName === "string" ? v.inviterName : "",
        role: typeof v.role === "string" ? v.role : "member",
      };
    }
  } catch {
    /* not ours */
  }
  return null;
}

/** Publish one event to every live connection of `userId`. */
export function publishUserEvent(pubsub: PubSub, userId: string, event: UserEvent): Promise<void> {
  return pubsub.publish(userTopic(userId), encodeUserEvent(event));
}

// The pub/sub exists only once the process entrypoint built the vault channel;
// until then (and in unit tests that never start it) announcing is a no-op.
let publisher: ((userId: string, event: UserEvent) => void) | null = null;

export function setUserEventPublisher(fn: ((userId: string, event: UserEvent) => void) | null): void {
  publisher = fn;
}

/** The account (if any) that `email` signs in as. */
async function userIdForEmail(email: string): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM "user" WHERE lower(email) = lower($1) LIMIT 1`,
    [email],
  );
  return rows[0]?.id ?? null;
}

/**
 * Tell the invitee's open apps that an invitation arrived. Best-effort: an
 * invitee with no account yet has nothing open, and a failure only means the
 * app shows it on its next refresh. Never throws.
 */
export async function announceInvitation(args: {
  email: string;
  invitationId: string;
  orgId: string;
  orgName: string;
  inviterName: string;
  role: string;
}): Promise<void> {
  if (!publisher) return;
  try {
    const userId = await userIdForEmail(args.email);
    if (!userId) return;
    publisher(userId, {
      t: "invitation",
      invitationId: args.invitationId,
      orgId: args.orgId,
      orgName: args.orgName,
      inviterName: args.inviterName,
      role: args.role,
    });
  } catch (err) {
    console.error("[invitations] live announce failed:", err);
  }
}

/** Accepted, declined or cancelled: the invitee's other devices drop the row. */
export async function announceInvitationGone(
  invitationId: string,
  who: { email?: string | null; userId?: string | null },
): Promise<void> {
  if (!publisher) return;
  try {
    const userId = who.userId ?? (who.email ? await userIdForEmail(who.email) : null);
    if (!userId) return;
    publisher(userId, { t: "invitation-gone", invitationId });
  } catch (err) {
    console.error("[invitations] live gone announce failed:", err);
  }
}
