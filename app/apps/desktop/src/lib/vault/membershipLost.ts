// Membership ended: this device stops syncing that vault and PERMANENTLY
// deletes its folder (owner decision 2026-10-09). Pure helpers only; the
// store action `handleMembershipLost` runs the teardown.
//
// The trigger is always a POSITIVE authenticated server answer: the vault
// channel's `member-removed` frame for the signed-in user, a confirmed leave,
// or `notMember` from `POST /api/orgs/membership-check`. A bare 403/404 never
// counts: a wrong server URL or a stale stamp answers those too.
//
// Owners are safe by construction: an owner is always a member, so a vault
// still listed in the account's organizations is never acted on.

export type MembershipLossReason = "removed" | "left";

/** The ONE notice line shown after the folder is gone. */
export function membershipLostNotice(vaultName: string, reason: MembershipLossReason): string {
  const name = vaultName.trim() || "this vault";
  return reason === "left"
    ? `You left ${name}. Its files were removed from this device.`
    : `You were removed from ${name}. Its files were removed from this device.`;
}

/** Should a `member-removed` frame be acted on? Only for the signed-in user. */
export function frameTargetsMe(frameUserId: string, myUserId: string | null | undefined): boolean {
  return !!myUserId && frameUserId === myUserId;
}

/** Max ids per `membership-check` request. */
export const MEMBERSHIP_CHECK_CHUNK = 200;

/**
 * Which vaults the launch check asks about: orgs this account was SEEN to be a
 * member of on this server (the ledger), that still have a folder bound on
 * this device, and that the account no longer lists. Anything still listed is
 * a live membership (owners included) and is never asked about.
 */
export function orgIdsToCheck(input: {
  ledger: readonly string[];
  bound: Readonly<Record<string, string>>;
  listed: readonly string[];
}): string[] {
  const listed = new Set(input.listed);
  const out: string[] = [];
  for (const orgId of new Set(input.ledger)) {
    if (listed.has(orgId)) continue;
    if (!input.bound[orgId]) continue;
    out.push(orgId);
  }
  return out;
}

export function chunk<T>(items: readonly T[], size = MEMBERSHIP_CHECK_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The verdict of one membership-check answer: only ids we ASKED about that the
 * server put in `notMember` (and nowhere else) are removals. `unknown`, a
 * malformed body and anything not asked about are never removals.
 */
export function removalsFromCheck(asked: readonly string[], body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const b = body as { member?: unknown; notMember?: unknown; unknown?: unknown };
  if (!Array.isArray(b.notMember)) return [];
  const askedSet = new Set(asked);
  const other = new Set<string>([
    ...(Array.isArray(b.member) ? b.member : []),
    ...(Array.isArray(b.unknown) ? b.unknown : []),
  ].filter((x): x is string => typeof x === "string"));
  const out: string[] = [];
  for (const id of new Set(b.notMember)) {
    if (typeof id !== "string" || !askedSet.has(id) || other.has(id)) continue;
    out.push(id);
  }
  return out;
}

/**
 * How the store treats a membership-check failure: 404 = the server lacks the
 * route (remember it per server URL and stop asking); anything else = skip
 * this pass and ask again next launch. Neither is ever a removal.
 */
export function checkFailure(status: number | null): "unsupported" | "skip" {
  return status === 404 ? "unsupported" : "skip";
}

// ── Ledger: orgs this account was a member of, per (server, user) ──────────
// The launch check asks only about these, so a folder bound by another
// account or another server is never deleted on a `notMember` answer.

const LEDGER_KEY = "context.knownMemberships";

export function ledgerKey(serverUrl: string, userId: string): string {
  return `${serverUrl.replace(/\/+$/, "")}|${userId}`;
}

type Ledger = Record<string, string[]>;

function readLedger(): Ledger {
  try {
    const raw = JSON.parse(localStorage.getItem(LEDGER_KEY) ?? "{}") as unknown;
    return raw && typeof raw === "object" ? (raw as Ledger) : {};
  } catch {
    return {};
  }
}

function writeLedger(l: Ledger): void {
  try {
    localStorage.setItem(LEDGER_KEY, JSON.stringify(l));
  } catch {
    /* best-effort */
  }
}

export function knownMemberships(serverUrl: string, userId: string): string[] {
  return readLedger()[ledgerKey(serverUrl, userId)] ?? [];
}

export function rememberMemberships(serverUrl: string, userId: string, orgIds: readonly string[]): void {
  if (orgIds.length === 0) return;
  const l = readLedger();
  const k = ledgerKey(serverUrl, userId);
  const next = new Set([...(l[k] ?? []), ...orgIds]);
  if (next.size === (l[k] ?? []).length) return;
  l[k] = [...next];
  writeLedger(l);
}

export function forgetMembership(serverUrl: string, userId: string, orgId: string): void {
  const l = readLedger();
  const k = ledgerKey(serverUrl, userId);
  if (!l[k]?.includes(orgId)) return;
  l[k] = l[k].filter((id) => id !== orgId);
  writeLedger(l);
}

// ── Unsupported servers (404 on the route), per server URL, this run ───────
const unsupported = new Set<string>();
export function markMembershipCheckUnsupported(serverUrl: string): void {
  unsupported.add(serverUrl.replace(/\/+$/, ""));
}
export function membershipCheckUnsupported(serverUrl: string): boolean {
  return unsupported.has(serverUrl.replace(/\/+$/, ""));
}
