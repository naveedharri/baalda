// Who a message is for (docs/MESSAGES.md). Every audience field narrows (AND).
// User-level fields (userIds, emails, versions, sign-up dates) judge the
// person; org-level fields (roles, orgIds, encryptedVaults) judge one of their
// vaults: a per-vault message goes to each vault that passes, an account-wide
// one to anyone with at least one such vault. Pure; `service.ts` loads the
// context once per request.
import { parseClientVersion } from "../http/client-version.js";
import type { MessageAudience, MessageRole } from "./spec.js";

export interface MessageOrg {
  orgId: string;
  orgName: string;
  role: MessageRole | string;
  /** The org's note collection (`vaults` row); null when it has none yet. */
  vaultId: string | null;
  keyed: boolean;
  keyGeneration: number;
  /** `vault_key_backups` has this user's row for the current generation. */
  keySaved: boolean;
}

export interface MessageUserContext {
  userId: string;
  email: string;
  signedUpAt: Date | null;
  orgs: MessageOrg[];
}

type Version = readonly [number, number, number];

function cmp(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** A missing or unreadable client version fails any version bound: only target what we know. */
export function versionInRange(raw: string | null | undefined, min?: string, max?: string): boolean {
  if (!min && !max) return true;
  const v = parseClientVersion(raw);
  if (!v) return false;
  if (min && cmp(v, parseClientVersion(min) as Version) < 0) return false;
  if (max && cmp(v, parseClientVersion(max) as Version) > 0) return false;
  return true;
}

export function userMatches(aud: MessageAudience | undefined, ctx: MessageUserContext, version: string | null | undefined): boolean {
  if (!aud) return true;
  if (aud.userIds && !aud.userIds.includes(ctx.userId)) return false;
  if (aud.emails && !aud.emails.includes(ctx.email.toLowerCase())) return false;
  if (!versionInRange(version, aud.minVersion, aud.maxVersion)) return false;
  if (aud.signedUpBefore || aud.signedUpAfter) {
    if (!ctx.signedUpAt) return false;
    const at = ctx.signedUpAt.getTime();
    if (aud.signedUpBefore && at >= Date.parse(aud.signedUpBefore)) return false;
    if (aud.signedUpAfter && at <= Date.parse(aud.signedUpAfter)) return false;
  }
  return true;
}

export function hasOrgFilter(aud: MessageAudience | undefined): boolean {
  return !!aud && (aud.roles !== undefined || aud.orgIds !== undefined || aud.encryptedVaults !== undefined);
}

export function orgMatches(aud: MessageAudience | undefined, org: MessageOrg): boolean {
  if (!aud) return true;
  if (aud.roles && !aud.roles.includes(org.role as MessageRole)) return false;
  if (aud.orgIds && !aud.orgIds.includes(org.orgId)) return false;
  if (aud.encryptedVaults !== undefined && org.keyed !== aud.encryptedVaults) return false;
  return true;
}
