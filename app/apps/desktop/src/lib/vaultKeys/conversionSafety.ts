// Zero data loss before converting a vault (owner decision 2026-11-01: every
// vault is encrypted automatically, no opt-in). A device starts converting
// only when losing THIS computer could not lose the vault key:
//   (a) at least one OTHER member has an account key (they receive the key at
//       conversion, so a lost laptop is recoverable from them), or
//   (b) this account has a password wrap of its account key (password unlock
//       works on a new laptop), or
//   (c) this account has 2+ approved devices. Known gap, kept on purpose: the
//       count is `/me/keys` device rows + 1, and a device that was uninstalled
//       without being revoked still has a row, so (c) can over-count. The
//       launch safety net (server recovery copies sealed to an offline key)
//       covers that window.
//   (d) the server's launch safety net is on (owner decision 2026-11-01): Baalda
//       can rescue a lost key with its offline recovery key, so every vault,
//       a Google-only solo owner's included, encrypts during launch. Before the
//       net is switched off, owners with no other way back see the "save your
//       vault key" card (components/SaveVaultKeyCard.tsx).
// Unknown counts (an older server that does not report them) count as not met.
// Not safe yet means "ask again on a later run", never an error.

export interface ConversionSafetyFacts {
  /** Current members other than this user who have an account key. */
  otherMembersWithKeys?: number | null;
  /** This account's key is wrapped under its password on the server. */
  hasPasswordWrap: boolean;
  /** Devices of this account holding the account key. */
  approvedDevices?: number | null;
  /** The server keeps launch recovery copies sealed to an offline key. */
  recoveryNet?: boolean;
}

export function conversionSafe(f: ConversionSafetyFacts): boolean {
  if (f.recoveryNet === true) return true;
  if (typeof f.otherMembersWithKeys === "number" && f.otherMembersWithKeys >= 1) return true;
  if (f.hasPasswordWrap) return true;
  return typeof f.approvedDevices === "number" && f.approvedDevices >= 2;
}
