// In-app messages: which pending messages one person sees, their receipts,
// and the operator's CRUD (docs/MESSAGES.md). `pendingMessages` runs a fixed
// three queries (context, live messages, receipts) however many messages or
// vaults there are; conditions evaluate against the loaded context.
import { pool } from "../db/pool.js";
import { hasOrgFilter, orgMatches, userMatches, type MessageUserContext } from "./audience.js";
import { evaluateCondition } from "./conditions.js";
import { publicSpec, type MessageSpec, type PublicMessageSpec } from "./spec.js";

type Queryable = Pick<typeof pool, "query">;

/** Messages `GET /api/messages` answers at most. */
export const MAX_DELIVERED = 5;
const DEFAULT_SNOOZE_HOURS = 72;
const DEFAULT_GAP_HOURS = 24;
const HOUR = 3600_000;

export interface DeliveredMessage {
  spec: PublicMessageSpec;
  orgId: string | null;
  vaultId: string | null;
  vaultName: string | null;
  showCount: number;
  lastShownAt: string | null;
}

interface ReceiptRow {
  message_id: string;
  org_id: string;
  last_shown_at: Date | null;
  show_count: number;
  snoozed_until: Date | null;
  done_at: Date | null;
  dismissed_at: Date | null;
}

export async function loadUserContext(userId: string, db: Queryable = pool): Promise<MessageUserContext | null> {
  const { rows } = await db.query<{
    email: string;
    created_at: Date | null;
    org_id: string | null;
    org_name: string | null;
    role: string | null;
    vault_id: string | null;
    keyed: boolean | null;
    generation: number | null;
    saved: boolean | null;
  }>(
    `SELECT u.email, u."createdAt" AS created_at, m."organizationId" AS org_id, o.name AS org_name, m.role,
            v.id AS vault_id, v.vk_check IS NOT NULL AS keyed, COALESCE(v.key_generation, 1) AS generation,
            EXISTS (SELECT 1 FROM vault_key_backups b
                     WHERE b.org_id = m."organizationId" AND b.user_id = u.id
                       AND b.generation = COALESCE(v.key_generation, 1)) AS saved
       FROM "user" u
       LEFT JOIN member m ON m."userId" = u.id
       LEFT JOIN organization o ON o.id = m."organizationId"
       LEFT JOIN LATERAL (
         SELECT id, vk_check, key_generation FROM vaults
          WHERE organization_id = m."organizationId" ORDER BY created_at, id LIMIT 1
       ) v ON true
      WHERE u.id = $1`,
    [userId],
  );
  if (!rows[0]) return null;
  return {
    userId,
    email: rows[0].email,
    signedUpAt: rows[0].created_at,
    orgs: rows
      .filter((r) => r.org_id)
      .map((r) => ({
        orgId: r.org_id as string,
        orgName: r.org_name ?? "",
        role: r.role ?? "member",
        vaultId: r.vault_id,
        keyed: !!r.keyed,
        keyGeneration: r.generation ?? 1,
        keySaved: !!r.saved,
      })),
  };
}

/**
 * Frequency + receipt rules; `r` is undefined when the person never saw it.
 * `showing`: the desktop is displaying this one right now, so only answers
 * (done, dismiss, snooze) hide it, never its own `shown` receipt.
 */
export function receiptAllows(spec: MessageSpec, r: ReceiptRow | undefined, now: number, showing = false): boolean {
  if (!r) return true;
  if (r.done_at) return false;
  if (r.snoozed_until && r.snoozed_until.getTime() > now) return false;
  const f = spec.frequency ?? {};
  const mode = f.mode ?? "until-done";
  if (mode === "once" && r.dismissed_at) return false;
  if (mode === "until-done" && r.dismissed_at) {
    const gap = (f.minHoursBetweenShows ?? DEFAULT_GAP_HOURS) * HOUR;
    if (r.dismissed_at.getTime() + gap > now) return false;
  }
  if (showing) return true;
  if (f.maxShows !== undefined && r.show_count >= f.maxShows) return false;
  const last = r.last_shown_at?.getTime() ?? null;
  if (mode === "once" && r.show_count > 0) return false;
  if (mode === "every" && last !== null && last + (f.everyHours ?? DEFAULT_GAP_HOURS) * HOUR > now) return false;
  if (f.minHoursBetweenShows !== undefined && last !== null && last + f.minHoursBetweenShows * HOUR > now) return false;
  return true;
}

/** The (message, org) pair a desktop is displaying; `orgId` null = account-wide. */
export interface ShowingPair {
  messageId: string;
  orgId: string | null;
}

export async function pendingMessages(
  userId: string,
  clientVersion: string | null | undefined,
  db: Queryable = pool,
  showing: ShowingPair | null = null,
  /** The open vault's org (null: none). Undefined: a build that doesn't say, gets every vault. */
  openOrgId?: string | null,
): Promise<DeliveredMessage[]> {
  const ctx = await loadUserContext(userId, db);
  if (!ctx) return [];
  const { rows: messages } = await db.query<{ id: string; spec: MessageSpec }>(
    `SELECT id, spec FROM app_messages
      WHERE archived_at IS NULL
        AND (starts_at IS NULL OR starts_at <= now())
        AND (ends_at IS NULL OR ends_at > now())
      ORDER BY priority DESC, created_at ASC, id`,
  );
  if (messages.length === 0) return [];
  const { rows: receipts } = await db.query<ReceiptRow>(
    `SELECT message_id, org_id, last_shown_at, show_count, snoozed_until, done_at, dismissed_at
       FROM app_message_receipts WHERE user_id = $1`,
    [userId],
  );
  const byKey = new Map(receipts.map((r) => [`${r.message_id}\0${r.org_id}`, r]));
  const now = Date.now();
  const out: DeliveredMessage[] = [];
  for (const { id, spec } of messages) {
    if (!userMatches(spec.audience, ctx, clientVersion)) continue;
    let targets: { orgId: string | null; vaultId: string | null; vaultName: string | null }[];
    if (spec.condition) {
      targets = evaluateCondition(spec.condition, ctx).filter((t) => {
        const org = ctx.orgs.find((o) => o.orgId === t.orgId);
        return !!org && orgMatches(spec.audience, org);
      });
    } else if (spec.perVault) {
      targets = ctx.orgs
        .filter((o) => o.vaultId && orgMatches(spec.audience, o))
        .map((o) => ({ orgId: o.orgId, vaultId: o.vaultId, vaultName: o.orgName }));
    } else {
      if (hasOrgFilter(spec.audience) && !ctx.orgs.some((o) => orgMatches(spec.audience, o))) continue;
      targets = [{ orgId: null, vaultId: null, vaultName: null }];
    }
    for (const t of targets) {
      const r = byKey.get(`${id}\0${t.orgId ?? ""}`);
      const isShowing = showing?.messageId === id && (showing.orgId ?? "") === (t.orgId ?? "");
      // The app only shows a per-vault message in that vault, so the copies for
      // other vaults must not use up MAX_DELIVERED and crowd this one out.
      if (openOrgId !== undefined && t.orgId && t.orgId !== openOrgId && !isShowing) continue;
      if (!receiptAllows(spec, r, now, isShowing)) continue;
      out.push({
        spec: publicSpec(spec),
        ...t,
        showCount: r?.show_count ?? 0,
        lastShownAt: r?.last_shown_at?.toISOString() ?? null,
      });
      if (out.length >= MAX_DELIVERED) return out;
    }
  }
  return out;
}

export type ReceiptEvent = "shown" | "snooze" | "dismiss" | "done";

/** The live (not archived) spec, or null. */
export async function liveSpec(id: string, db: Queryable = pool): Promise<MessageSpec | null> {
  const { rows } = await db.query<{ spec: MessageSpec }>(
    "SELECT spec FROM app_messages WHERE id = $1 AND archived_at IS NULL",
    [id],
  );
  return rows[0]?.spec ?? null;
}

export function snoozeHours(spec: MessageSpec, actionId: string | undefined): number {
  const action = actionId ? spec.actions?.find((a) => a.id === actionId && a.kind === "remind-later") : undefined;
  const hours = action?.hours ?? DEFAULT_SNOOZE_HOURS;
  return Math.min(720, Math.max(1, hours));
}

export async function recordReceipt(
  spec: MessageSpec,
  userId: string,
  orgId: string | null,
  event: ReceiptEvent,
  actionId: string | undefined,
  db: Queryable = pool,
): Promise<void> {
  const key = [spec.id, userId, orgId ?? ""];
  const action = actionId ?? null;
  switch (event) {
    case "shown":
      await db.query(
        `INSERT INTO app_message_receipts (message_id, user_id, org_id, first_shown_at, last_shown_at, show_count)
         VALUES ($1, $2, $3, now(), now(), 1)
         ON CONFLICT (message_id, user_id, org_id) DO UPDATE
           SET show_count = app_message_receipts.show_count + 1, last_shown_at = now(),
               first_shown_at = COALESCE(app_message_receipts.first_shown_at, now())`,
        key,
      );
      return;
    case "snooze":
      await db.query(
        `INSERT INTO app_message_receipts (message_id, user_id, org_id, snoozed_until, action_id)
         VALUES ($1, $2, $3, now() + make_interval(hours => $4), $5)
         ON CONFLICT (message_id, user_id, org_id) DO UPDATE
           SET snoozed_until = EXCLUDED.snoozed_until, action_id = EXCLUDED.action_id`,
        [...key, snoozeHours(spec, actionId), action],
      );
      return;
    case "dismiss":
    case "done": {
      const col = event === "done" ? "done_at" : "dismissed_at";
      await db.query(
        `INSERT INTO app_message_receipts (message_id, user_id, org_id, ${col}, action_id)
         VALUES ($1, $2, $3, now(), $4)
         ON CONFLICT (message_id, user_id, org_id) DO UPDATE
           SET ${col} = now(), action_id = EXCLUDED.action_id`,
        [...key, action],
      );
      return;
    }
  }
}

// ── Admin ───────────────────────────────────────────────────────────────────

export interface AdminMessage {
  spec: MessageSpec;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

interface MessageRow {
  spec: MessageSpec;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}

function toAdmin(r: MessageRow): AdminMessage {
  return {
    spec: r.spec,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    archivedAt: r.archived_at?.toISOString() ?? null,
  };
}

const COLUMNS = "spec, created_at, updated_at, archived_at";

export async function listAllMessages(db: Queryable = pool): Promise<AdminMessage[]> {
  const { rows } = await db.query<MessageRow>(
    `SELECT ${COLUMNS} FROM app_messages ORDER BY archived_at IS NOT NULL, priority DESC, created_at`,
  );
  return rows.map(toAdmin);
}

/** null when the id is taken. */
export async function createMessage(spec: MessageSpec, db: Queryable = pool): Promise<AdminMessage | null> {
  const { rows } = await db.query<MessageRow>(
    `INSERT INTO app_messages (id, spec, priority, starts_at, ends_at) VALUES ($1, $2::jsonb, $3, $4, $5)
     ON CONFLICT (id) DO NOTHING RETURNING ${COLUMNS}`,
    [spec.id, JSON.stringify(spec), spec.priority ?? 0, spec.startsAt ?? null, spec.endsAt ?? null],
  );
  return rows[0] ? toAdmin(rows[0]) : null;
}

export async function updateMessage(
  spec: MessageSpec,
  db: Queryable = pool,
): Promise<{ ok: true; message: AdminMessage } | { ok: false; reason: "not_found" | "archived" }> {
  const { rows } = await db.query<MessageRow>(
    `UPDATE app_messages SET spec = $2::jsonb, priority = $3, starts_at = $4, ends_at = $5, updated_at = now()
      WHERE id = $1 AND archived_at IS NULL RETURNING ${COLUMNS}`,
    [spec.id, JSON.stringify(spec), spec.priority ?? 0, spec.startsAt ?? null, spec.endsAt ?? null],
  );
  if (rows[0]) return { ok: true, message: toAdmin(rows[0]) };
  const { rows: exists } = await db.query("SELECT 1 FROM app_messages WHERE id = $1", [spec.id]);
  return { ok: false, reason: exists.length ? "archived" : "not_found" };
}

/** One-way; false when the id is unknown. */
export async function archiveMessage(id: string, db: Queryable = pool): Promise<boolean> {
  const { rowCount } = await db.query(
    "UPDATE app_messages SET archived_at = COALESCE(archived_at, now()), updated_at = now() WHERE id = $1",
    [id],
  );
  return (rowCount ?? 0) > 0;
}

export interface MessageStats {
  shown: number;
  snoozed: number;
  dismissed: number;
  done: number;
  people: number;
}

export async function messageStats(id: string, db: Queryable = pool): Promise<MessageStats | null> {
  const { rows: exists } = await db.query("SELECT 1 FROM app_messages WHERE id = $1", [id]);
  if (!exists.length) return null;
  const { rows } = await db.query<{ shown: number; snoozed: number; dismissed: number; done: number; people: number }>(
    `SELECT count(*) FILTER (WHERE show_count > 0)::int AS shown,
            count(*) FILTER (WHERE snoozed_until IS NOT NULL)::int AS snoozed,
            count(*) FILTER (WHERE dismissed_at IS NOT NULL)::int AS dismissed,
            count(*) FILTER (WHERE done_at IS NOT NULL)::int AS done,
            count(DISTINCT user_id)::int AS people
       FROM app_message_receipts WHERE message_id = $1`,
    [id],
  );
  return rows[0];
}
