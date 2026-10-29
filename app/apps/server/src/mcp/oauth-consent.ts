// SPDX-License-Identifier: Apache-2.0
//
// Connector consent finished by the desktop (W3, security rule 2). For a vault
// that is keyed (or converting), the browser consent page cannot complete on
// its own: the server must never wrap a key from its cache for a user flow.
// It opens an `oauth_consents` row and shows "Open Baalda on your computer to
// finish connecting" with a `<scheme>://oauth-consent?id=…` deep link. The
// desktop, signed in as the SAME user, presents VK for the vault; the server
// verifies it against the vault's check and holds it in process memory only
// (`holdConsentKeys`) until the authorization code is exchanged, when
// `rewrapOnIssue` wraps it under the connector's new tokens.
//
// A session forged in the database cannot finish a consent: it has no VK.
import { randomBytes } from "node:crypto";
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { vaultKeysEnabled } from "../crypto/config.js";
import { decodeVk } from "../crypto/transport.js";
import { verifyVk } from "../crypto/vk-check.js";
import { CONSENT_TTL_MS, hasConsentKeys, holdConsentKeys } from "./oauth-grant-keys.js";
import { orgVaultChecks } from "./token-keys.js";

type Queryable = Pick<pg.Pool, "query">;

/** Does connecting this vault need the desktop step? */
export async function consentNeedsDesktop(orgId: string, db: Queryable = defaultPool): Promise<boolean> {
  if (!vaultKeysEnabled()) return false;
  return (await orgVaultChecks(orgId, db)).length > 0;
}

/** An approved consent whose keys this process still holds, or null. */
export async function readyConsent(
  userId: string,
  clientId: string,
  orgId: string,
  db: Queryable = defaultPool,
): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM oauth_consents
      WHERE user_id = $1 AND client_id = $2 AND organization_id = $3
        AND approved_at IS NOT NULL AND consumed_at IS NULL AND expires_at > now()
      ORDER BY approved_at DESC`,
    [userId, clientId, orgId],
  );
  return rows.find((r) => hasConsentKeys(r.id))?.id ?? null;
}

/** The open (unapproved, unexpired) consent for this triple, or a new one. */
export async function openConsent(
  userId: string,
  clientId: string,
  orgId: string,
  db: Queryable = defaultPool,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM oauth_consents
      WHERE user_id = $1 AND client_id = $2 AND organization_id = $3
        AND approved_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`,
    [userId, clientId, orgId],
  );
  if (rows[0]) return rows[0].id;
  const id = randomBytes(18).toString("base64url");
  await db.query(
    `INSERT INTO oauth_consents (id, user_id, client_id, organization_id, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))`,
    [id, userId, clientId, orgId, CONSENT_TTL_MS / 1000],
  );
  return id;
}

export interface ConsentView {
  id: string;
  clientId: string;
  app: string;
  organizationId: string;
  vaultName: string;
  /** The org's note collections (`vaults.id`) the desktop must present keys for. */
  vaultIds: string[];
  approved: boolean;
}

/** A live consent of THIS user, for the desktop's confirm prompt / the page's poll. */
export async function consentFor(id: string, userId: string, db: Queryable = defaultPool): Promise<ConsentView | null> {
  const { rows } = await db.query<{
    id: string;
    client_id: string;
    organization_id: string;
    approved_at: Date | null;
    app: string | null;
    vault_name: string | null;
    vault_ids: string[] | null;
  }>(
    `SELECT c.id, c.client_id, c.organization_id, c.approved_at, a.name AS app, o.name AS vault_name,
            (SELECT array_agg(v.id ORDER BY v.id) FROM vaults v WHERE v.organization_id = c.organization_id) AS vault_ids
       FROM oauth_consents c
       LEFT JOIN "oauthApplication" a ON a."clientId" = c.client_id
       LEFT JOIN organization o ON o.id = c.organization_id
      WHERE c.id = $1 AND c.user_id = $2 AND c.consumed_at IS NULL AND c.expires_at > now()`,
    [id, userId],
  );
  const r = rows[0];
  // Approved but the keys are gone (server restarted): nothing can finish it,
  // so it reads as expired and the page tells the person to start again.
  if (!r || (r.approved_at && !hasConsentKeys(r.id))) return null;
  return {
    id: r.id,
    clientId: r.client_id,
    app: r.app?.trim() || "An application",
    organizationId: r.organization_id,
    vaultName: r.vault_name ?? "",
    vaultIds: r.vault_ids ?? [],
    approved: !!r.approved_at && hasConsentKeys(r.id),
  };
}

export type CompleteResult = { ok: true } | { ok: false; status: 404 | 409; code: string };

/**
 * The desktop finishes a consent: every keyed or converting vault of the org
 * must be covered by a presented key that verifies (`X-Baalda-VK`: one bare
 * base64 key, or `vaultId=<b64>` pairs). Nothing is stored unless all verify.
 */
export async function completeConsent(
  id: string,
  userId: string,
  vkHeader: string | undefined,
  db: Queryable = defaultPool,
): Promise<CompleteResult> {
  const view = await consentFor(id, userId, db);
  if (!view) return { ok: false, status: 404, code: "not_found" };
  const checks = await orgVaultChecks(view.organizationId, db);
  const offered: Array<{ vaultId: string | null; key: Buffer }> = [];
  for (const part of (vkHeader ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = part.indexOf("=", 1);
    const named = eq > 0 && !/^[A-Za-z0-9+/_-]+={1,2}$/.test(part);
    const key = decodeVk(named ? part.slice(eq + 1) : part);
    if (key) offered.push({ vaultId: named ? part.slice(0, eq) : null, key });
  }
  const keys: Array<{ vaultId: string; key: Buffer; generation: number }> = [];
  for (const v of checks) {
    const hit = offered.find((o) => (o.vaultId === null || o.vaultId === v.vaultId) && verifyVk(o.key, v.vaultId, v.check));
    if (!hit) {
      for (const o of offered) o.key.fill(0);
      return { ok: false, status: 409, code: "key_required" };
    }
    keys.push({ vaultId: v.vaultId, key: hit.key, generation: v.generation });
  }
  holdConsentKeys(id, keys); // copies
  for (const o of offered) o.key.fill(0);
  await db.query("UPDATE oauth_consents SET approved_at = now() WHERE id = $1 AND user_id = $2", [id, userId]);
  return { ok: true };
}
