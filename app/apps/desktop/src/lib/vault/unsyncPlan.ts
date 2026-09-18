// What a folder stamped for a vault this account cannot see actually MEANS.
//
// `planTurnOnSync` already refuses such a folder (`blocked-foreign`), and for
// its own case that is right: adopting a teammate's folder would upload every
// note in it into a fresh vault under the wrong account. But the same shape has
// a second, opposite cause — the vault's owner made it LOCAL ONLY (or deleted
// it), so there is nothing to protect and the refusal is a permanent dead end:
// the stamp names an org that will never exist again, and the folder can never
// sync anywhere.
//
// The two are indistinguishable from the folder alone. `GET /api/orgs/:id/status`
// is what separates them, and this is the pure reading of its answer.
//
// Pure: no store, no IPC, no network. The caller does the asking.

import type { OrgStatus } from "../api";

/** The server's answer to "does this vault exist and am I in it?". */
export type UnsyncStatusAnswer = OrgStatus["kind"];

export type UnsyncStampVerdict =
  /** The vault is gone from the server: offer "keep local" / "sync again". */
  | "local-only"
  /** It exists and belongs to someone else: today's `blocked-foreign` refusal stands. */
  | "foreign"
  /** Nothing is wrong — no stamp, or we really are a member of the stamped vault. */
  | "ok"
  /** We could not find out. Say NOTHING: a banner that fires on a flaky network
   *  would tell a healthy vault it had been deleted. */
  | "unknown";

export interface UnsyncPlanInput {
  /** The org the open folder's `.context/config.json` is stamped for, or null. */
  stampedOrgId: string | null;
  /** The vaults this account is a member of right now. */
  knownOrgIds: readonly string[];
  /**
   * What `/status` said for `stampedOrgId`. Only consulted when the stamp names
   * an org that is NOT in `knownOrgIds` — a stamp we can explain locally never
   * needs the network.
   */
  statusAnswer: UnsyncStatusAnswer;
}

export function planUnsyncStamp(input: UnsyncPlanInput): UnsyncStampVerdict {
  const stamped = input.stampedOrgId;
  // A folder that was never synced, or one whose vault we are plainly still in,
  // has nothing to explain. This is also the cheap exit that keeps the probe off
  // the launch path for every healthy vault.
  if (!stamped) return "ok";
  if (input.knownOrgIds.includes(stamped)) return "ok";

  switch (input.statusAnswer) {
    case "vault-not-found":
      return "local-only";
    case "not-a-member":
      return "foreign";
    // The vault list was merely stale (a refresh that had not landed yet): the
    // server says we ARE a member, and the server is the authority.
    case "member":
      return "ok";
    default:
      return "unknown";
  }
}
