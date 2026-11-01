// The `baalda://oauth-consent?id=<consent>&server=<url>` hand-off (W3, security
// rule 2). Connecting claude.ai or ChatGPT to a keyed vault is finished in the
// app: the server's consent page cannot hand the vault key over itself, so it
// bounces here. The link carries only an opaque consent id; the app reads the
// request from ITS OWN signed-in server, shows who is asking for which vault,
// and only on the person's click presents the vault key. A link for another
// server, or another account, does nothing.
//
// Both foldings are accepted, like every other link parser here.

import { isAppProtocol } from "./deepLinkScheme";
import { normalizeServerUrl } from "./auth/serverChoice";
import type { ApiClient } from "./api";

export interface OAuthConsentLink {
  id: string;
  /** The server that issued it (normalized), or null when absent/invalid. */
  server: string | null;
}

export function parseOAuthConsentLink(url: string): OAuthConsentLink | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!isAppProtocol(parsed.protocol)) return null;
  // `baalda://evil.example@oauth-consent` only dresses the link up: refuse it.
  if (parsed.username || parsed.password) return null;
  const segments = [parsed.host, ...parsed.pathname.split("/")].filter((s) => s.length > 0);
  if (segments.length !== 1 || segments[0] !== "oauth-consent") return null;
  const ids = parsed.searchParams.getAll("id");
  if (ids.length !== 1) return null;
  const id = ids[0].trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) return null;
  const rawServer = parsed.searchParams.get("server");
  if (!rawServer) return { id, server: null };
  // A server named but unreadable is not "no server named": refuse it.
  const server = normalizeServerUrl(rawServer);
  return server ? { id, server } : null;
}

/** Does the link belong to the server this app is signed in to? */
export function linkMatchesServer(link: OAuthConsentLink, serverUrl: string): boolean {
  if (!link.server) return true; // older pages: the id is checked by the server anyway
  return normalizeServerUrl(serverUrl) === link.server;
}

type KeyApi = Pick<ApiClient, "vaultKeyFor" | "ensureVaultKeyFor">;

/**
 * `X-Baalda-VK` for every collection of the consent's vault, as
 * `vaultId=<b64>` pairs; null when this device does not hold one of them.
 */
export async function consentKeyHeader(
  vaultIds: string[],
  api: KeyApi,
  /** True for a collection this device knows belongs to ANOTHER vault: the
   *  server's list is not trusted to pull in keys the prompt never named. */
  belongsElsewhere: (vaultId: string) => boolean = () => false,
): Promise<string | null> {
  if (!Array.isArray(vaultIds) || vaultIds.length > 16) return null;
  const parts: string[] = [];
  for (const id of vaultIds) {
    if (typeof id !== "string" || !id || belongsElsewhere(id)) return null;
    let vk = api.vaultKeyFor(id);
    if (!vk && (await api.ensureVaultKeyFor(id))) vk = api.vaultKeyFor(id);
    if (!vk) return null;
    parts.push(`${id}=${vk}`);
  }
  return parts.length > 0 ? parts.join(",") : null;
}
