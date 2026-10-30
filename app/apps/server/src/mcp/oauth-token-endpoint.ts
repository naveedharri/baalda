// SPDX-License-Identifier: Apache-2.0
//
// Wraps Better Auth's `POST /api/auth/mcp/token` so OAuth connector tokens are
// stored as hashes (see `oauth-token-hash.ts`) without changing what the
// client sees: the same request in, the same JSON out.
//
// Before: a refresh_token grant has its token mapped to the value the row
//   actually holds (legacy plaintext or `h1:` hash). An unknown token, or a
//   hash presented as a credential, is swapped for a value no row holds, so
//   Better Auth answers "invalid refresh token" exactly as today.
// After: the row Better Auth just wrote in plaintext is rewritten to hashes,
//   the consumed legacy row (Better Auth keeps it) is hashed in place, and the
//   `onIssued` hook (vault-key rewrap) runs. A failure after Better Auth
//   answered is logged and never fails the response: the client already has
//   working tokens, and a row left in plaintext still resolves.
import type pg from "pg";
import {
  findRefreshRow,
  hashIssuedRow,
  hashRowInPlace,
  unmatchableToken,
} from "./oauth-token-hash.js";

type Queryable = Pick<pg.Pool, "query">;

export interface IssuedGrant {
  /** The new row's id. */
  grantId: string;
  accessToken: string;
  refreshToken?: string;
  /** For a refresh grant: the consumed row and the plaintext refresh token. */
  previous?: { grantId: string; refreshToken: string; refreshHashHex: string };
}

export interface TokenEndpointHooks {
  onIssued?: (grant: IssuedGrant, db: Queryable) => Promise<void>;
}

/** True for the token endpoint path (trailing slashes tolerated). */
export function isMcpTokenPath(path: string): boolean {
  return path.replace(/\/+$/, "").toLowerCase() === "/api/auth/mcp/token";
}

/** True for Better Auth's HTTP session probe, which would answer a hashed
 *  value presented as a bearer; nothing of ours uses it over HTTP. */
export function isMcpGetSessionPath(path: string): boolean {
  return path.replace(/\/+$/, "").toLowerCase() === "/api/auth/mcp/get-session";
}

async function readParams(req: Request): Promise<{ params: Record<string, string>; json: boolean } | null> {
  const type = req.headers.get("content-type") ?? "";
  const text = await req.text();
  if (type.includes("application/json")) {
    try {
      const v = JSON.parse(text) as unknown;
      if (!v || typeof v !== "object") return null;
      const params: Record<string, string> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (val !== undefined && val !== null) params[k] = String(val);
      }
      return { params, json: true };
    } catch {
      return null;
    }
  }
  return { params: Object.fromEntries(new URLSearchParams(text)), json: false };
}

export async function handleMcpToken(
  req: Request,
  handler: (r: Request) => Promise<Response>,
  db: Queryable,
  hooks: TokenEndpointHooks = {},
): Promise<Response> {
  const parsed = await readParams(req.clone());
  if (!parsed) return handler(req);
  const { params, json } = parsed;

  let previous: IssuedGrant["previous"];
  let consumed: { id: string; legacyPlaintext: boolean } | null = null;
  if (params.grant_type === "refresh_token" && params.refresh_token) {
    const presented = params.refresh_token;
    const row = await findRefreshRow(db, presented);
    params.refresh_token = row ? row.stored : unmatchableToken();
    if (row) {
      consumed = row;
      previous = { grantId: row.id, refreshToken: presented, refreshHashHex: row.refreshHashHex };
    }
  }

  const headers = new Headers(req.headers);
  headers.delete("content-length");
  const body = json ? JSON.stringify(params) : new URLSearchParams(params).toString();
  const res = await handler(new Request(req.url, { method: "POST", headers, body }));
  if (!res.ok) return res;

  const text = await res.text();
  const out = new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
  try {
    const issued = JSON.parse(text) as { access_token?: unknown; refresh_token?: unknown };
    if (typeof issued.access_token !== "string") return out;
    const refreshToken = typeof issued.refresh_token === "string" ? issued.refresh_token : undefined;
    const grantId = await hashIssuedRow(db, issued.access_token, refreshToken);
    if (consumed?.legacyPlaintext) await hashRowInPlace(db, consumed.id);
    if (grantId && hooks.onIssued) {
      await hooks.onIssued({ grantId, accessToken: issued.access_token, refreshToken, previous }, db);
    }
  } catch (err) {
    console.warn("[oauth] post-issue step failed (tokens stay valid):", (err as Error).message);
  }
  return out;
}
