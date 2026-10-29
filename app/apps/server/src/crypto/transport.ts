// SPDX-License-Identifier: Apache-2.0
//
// How a vault key (VK) reaches the server (W3), and how it is checked. A key a
// user request presents is verified against `vaults.vk_check` on every request
// and kept on that request/connection only. The process key cache
// (`key-cache.ts`) is never consulted for a user request.
//
// Never log a VK: not the `X-Baalda-VK` header, not a per-doc token's suffix.
// `redactToken` is the only form of a sync token that may reach a log line.
import type { Context, MiddlewareHandler } from "hono";
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import {
  isVaultKeyCapableVersion,
  reportedClientVersion,
  vaultKeysOutdatedBody,
} from "../http/client-version.js";
import { vaultKeysEnabled } from "./config.js";
import { KEY_BYTES } from "./envelope.js";
import { verifyVk } from "./vk-check.js";
import { vaultKeyCache } from "./key-cache.js";

type Queryable = Pick<pg.Pool, "query">;

export const VK_HEADER = "x-baalda-vk";
export const KEY_REQUIRED_CODE = "key_required";
/** Hocuspocus close code for a keyed vault reached without a valid key. */
export const CLOSE_KEY_REQUIRED = 4409;

/**
 * A keyed vault reached without a valid vault key. Hocuspocus closes with
 * `code`/`reason` (4409 `key_required`); persistence throws it when sealed
 * rows are read, or a keyed doc written, without a key.
 */
export class KeyRequiredError extends Error {
  readonly code = CLOSE_KEY_REQUIRED;
  readonly reason = KEY_REQUIRED_CODE;
  constructor() {
    super(KEY_REQUIRED_CODE);
    this.name = "KeyRequiredError";
  }
}

/** Strict base64 → exactly 32 bytes, else null. */
export function decodeVk(raw: string | null | undefined): Buffer | null {
  if (!raw || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) return null;
  const buf = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return buf.length === KEY_BYTES ? buf : null;
}

/**
 * A per-doc sync token may carry the VK as `<jwt>.<vk-b64>`. A JWT already has
 * two dots, so split on the LAST dot only, and only when the suffix decodes to
 * exactly 32 bytes — a JWT signature is 43 base64url chars (32 bytes) too, so
 * the split also requires the remaining head to still look like a JWT (three
 * segments). Anything else is a plain token, exactly as today.
 */
export function splitSyncToken(token: string): { jwt: string; vk: Buffer | null } {
  const i = token.lastIndexOf(".");
  if (i <= 0) return { jwt: token, vk: null };
  const head = token.slice(0, i);
  if (head.split(".").length !== 3) return { jwt: token, vk: null };
  const vk = decodeVk(token.slice(i + 1));
  return vk ? { jwt: head, vk } : { jwt: token, vk: null };
}

/** A sync token reduced to what is safe to log (never the VK suffix). */
export function redactToken(token: unknown): string {
  if (typeof token !== "string") return "<none>";
  return `<token length ${splitSyncToken(token).jwt.length}>`;
}

/**
 * The vault's key state: null when the vault is not keyed (today's path).
 *
 * A NULL `vk_check` beside key material the vault can only have once keyed
 * (wraps, wrap history, a `vault_crypto_state` row) is a wiped check, never an
 * unkeyed vault: none of those exist without the check in normal operation.
 * Treating it as unkeyed would accept plaintext writes into a sealed vault, so
 * it answers an empty check that no key opens, and every path fails closed
 * with `key_required`.
 */
export async function loadVkCheck(
  vaultId: string,
  db: Queryable = defaultPool,
): Promise<{ vkCheck: Buffer; generation: number } | null> {
  const { rows } = await db.query<{ vk_check: Buffer | null; key_generation: number | null; orphaned: boolean }>(
    `SELECT v.vk_check, v.key_generation,
            (v.vk_check IS NULL AND (
               EXISTS (SELECT 1 FROM vault_key_wraps w WHERE w.vault_id = v.id)
            OR EXISTS (SELECT 1 FROM vault_key_wrap_history h WHERE h.vault_id = v.id)
            OR EXISTS (SELECT 1 FROM vault_crypto_state s WHERE s.vault_id = v.id))) AS orphaned
       FROM vaults v WHERE v.id = $1`,
    [vaultId],
  );
  const row = rows[0];
  if (row?.orphaned) return { vkCheck: Buffer.alloc(0), generation: row.key_generation ?? 1 };
  if (!row?.vk_check) return null;
  return { vkCheck: row.vk_check, generation: row.key_generation ?? 1 };
}

/**
 * Hono middleware: decode `X-Baalda-VK` once per request. Verification happens
 * per vault in {@link requireVaultKey}, since a request may name its vault only
 * in the path. Off-flag: does nothing.
 */
export const vaultKeyHeader: MiddlewareHandler = async (c, next) => {
  if (vaultKeysEnabled()) {
    const vk = decodeVk(c.req.header(VK_HEADER));
    if (vk) c.set("presentedVk" as never, vk as never);
  }
  await next();
};

export type VaultKeyResult =
  | { ok: true; key: Buffer | null; keyed: boolean; generation?: number }
  | { ok: false; response: Response };

/**
 * The verified VK for `vaultId` on this request. Unkeyed vault (or flag off):
 * `{ ok: true, key: null, keyed: false }`, today's path. Keyed vault with no
 * or a wrong key: a 409 `key_required` response to return as-is.
 */
export async function requireVaultKey(
  c: Context,
  vaultId: string,
  db: Queryable = defaultPool,
): Promise<VaultKeyResult> {
  if (!vaultKeysEnabled()) return { ok: true, key: null, keyed: false };
  const state = await loadVkCheck(vaultId, db);
  if (!state) return { ok: true, key: null, keyed: false };
  const vk = (c.get("presentedVk" as never) as Buffer | undefined) ?? decodeVk(c.req.header(VK_HEADER));
  if (vk && verifyVk(vk, vaultId, state.vkCheck)) {
    // A member's device just proved it holds the key: keep the vault keyed for
    // background work (index, idle versions) as a vault channel would. Fills
    // the cache only; this request is still served from ITS key, never from it.
    vaultKeyCache.holdForRequest(vaultId, vk, state.generation);
    return { ok: true, key: vk, keyed: true, generation: state.generation };
  }
  // A build that predates vault keys never sees `key_required` (it has never
  // handled it): it gets the 426 it already treats as "stop and update".
  if (!isVaultKeyCapableVersion(reportedClientVersion(c))) {
    return { ok: false, response: c.json(vaultKeysOutdatedBody(), 426) };
  }
  return {
    ok: false,
    response: c.json(
      { error: "This vault needs its key. Open Baalda on a device that has it.", code: KEY_REQUIRED_CODE },
      409,
    ),
  };
}

/**
 * For the routes that do not read the key themselves but lead to content of a
 * keyed vault (the sync and vault-channel token mints, registration without
 * state, bootstrap session create, blob intent/complete): a 426
 * `client_outdated` response when `vaultId` is keyed and this request comes
 * from a build without vault keys, else null. "Capable" = a verified
 * `X-Baalda-VK` OR a reported version >= `VAULT_KEYS_MIN_DESKTOP`; a missing
 * version is old. Unkeyed vault or flag off: null, at the cost of nothing
 * (unkeyed vaults behave exactly as before for every client).
 */
export async function refuseKeyIncapableClient(
  c: Context,
  vaultId: string,
  db: Queryable = defaultPool,
): Promise<Response | null> {
  if (!vaultKeysEnabled()) return null;
  if (isVaultKeyCapableVersion(reportedClientVersion(c))) return null;
  const state = await loadVkCheck(vaultId, db);
  if (!state) return null;
  const vk = (c.get("presentedVk" as never) as Buffer | undefined) ?? decodeVk(c.req.header(VK_HEADER));
  if (vk && verifyVk(vk, vaultId, state.vkCheck)) return null;
  return c.json(vaultKeysOutdatedBody(), 426);
}

/** The request's verified key as a persistence `DocCrypto`, or undefined (unkeyed). */
export function docCryptoOf(
  vaultId: string,
  r: { key: Buffer | null; generation?: number },
): { vaultId: string; key: Buffer; generation: number } | undefined {
  return r.key ? { vaultId, key: r.key, generation: r.generation ?? 1 } : undefined;
}
