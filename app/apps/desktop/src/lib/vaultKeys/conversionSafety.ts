// Zero data loss before converting a vault (owner decision 2026-11-01: every
// vault is encrypted automatically, no opt-in). A device starts converting
// only when losing THIS computer could not lose the vault key:
//   (a) at least one OTHER member has an account key (they receive the key at
//       conversion, so a lost laptop is recoverable from them), or
//   (b) this account has a password wrap of its account key (password unlock
//       works on a new laptop), or
//   (c) this account has 2+ approved devices.
// Unknown counts (an older server that does not report them) count as not met.
// Not safe yet means "ask again on a later run", never an error.

export interface ConversionSafetyFacts {
  /** Current members other than this user who have an account key. */
  otherMembersWithKeys?: number | null;
  /** This account's key is wrapped under its password on the server. */
  hasPasswordWrap: boolean;
  /** Devices of this account holding the account key. */
  approvedDevices?: number | null;
}

export function conversionSafe(f: ConversionSafetyFacts): boolean {
  if (typeof f.otherMembersWithKeys === "number" && f.otherMembersWithKeys >= 1) return true;
  if (f.hasPasswordWrap) return true;
  return typeof f.approvedDevices === "number" && f.approvedDevices >= 2;
}
