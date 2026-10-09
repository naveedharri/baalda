/**
 * One-off cut-over: move live subscriptions on the LEGACY per-vault products
 * onto the Team seat products while keeping each owner's price EXACT (plan §3.1).
 * Planning and execution live in `legacy-move-core.ts` (pure, unit-tested);
 * this file only parses flags and wires Polar + Postgres.
 *
 * Per billing account (one interval; an account with both a monthly and a
 * yearly live sub is refused, move one with --only):
 *   keep     = the live sub with the LATEST current_period_end (tie: larger amount)
 *   seats    = max(TEAM_MIN_SEATS, people + pending unexpired invites)
 *   target   = today's charge (--sum: every live legacy sub of the group, default;
 *              --larger: the largest one)
 *   discount = seats x per-seat list - target as a Polar FOREVER discount scoped
 *              to the Team product: FIXED amount by default (exact charge; a $0
 *              sub gets the full list), --percentage for basis points
 *   then: product -> Team product (+ discount) and, only if the effective seats
 *   differ, a seats PATCH, both with --proration.
 * Verify re-reads the subscription with the raw Polar client and requires:
 * product (pending or current) = Team product, effective seats = planned, the
 * attached discount of the planned type and amount (or basis points), and
 * expected charge = list - discount equal to the planned charge (fixed: the
 * target EXACTLY). Only after verify is OK are the group's other live subs
 * cancelled at period end. Any mismatch refuses that owner, cancels nothing.
 *
 * Re-runs are safe: a keeper already on the Team product with a `legacy-`
 * discount skips discount + product (the target is not recomputed), seats are
 * PATCHed only when they differ, and only subs not already cancelling are
 * cancelled.
 *
 * Preflight: both Team products are read from Polar and the run is refused if
 * their per-seat price differs from TEAM_PRICE_*_CENTS.
 *
 * Our DB is READ only here (accounts, people, invites, subscription -> account).
 * Every row change reaches Postgres through the normal webhooks.
 *
 * Usage (from app/apps/server, with the server env loaded):
 *   pnpm exec tsx scripts/billing/move-legacy-subs.ts                    # dry run
 *   pnpm exec tsx scripts/billing/move-legacy-subs.ts --execute --server sandbox
 *   pnpm exec tsx scripts/billing/move-legacy-subs.ts --execute --server production --yes
 *   flags: --larger (default sum)   --percentage (default fixed)
 *          --proration invoice|next_period (default next_period)
 *          --only <providerSubscriptionId> (that sub's account + interval group)
 * Refuses to act unless --execute AND --server equals POLAR_SERVER; production
 * also needs --yes.
 */
import { Polar } from "@polar-sh/sdk";
import { config, teamMinSeats, teamPricePerSeatCents, teamProductId } from "../../src/config.js";
import { pool } from "../../src/db/pool.js";
import { countAccountPeople, countPendingInvites } from "../../src/billing/accounts.js";
import { PolarBillingProvider } from "../../src/billing/polar.js";
import {
  describePlan,
  executeAccount,
  isRefusal,
  planAccount,
  seatPriceOf,
  toRawSubView,
  type ExecuteDeps,
  type Interval,
  type LegacySub,
  type ProrationMode,
} from "./legacy-move-core.js";

const argv = process.argv.slice(2);
const has = (f: string): boolean => argv.includes(f);
const val = (f: string): string | undefined => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const EXECUTE = has("--execute");
const SUM_MODE: "sum" | "larger" = has("--larger") ? "larger" : "sum";
const MODE: "fixed" | "percentage" = has("--percentage") ? "percentage" : "fixed";
const ONLY = val("--only");
// Default stays `next_period` until the Polar sandbox check (plan §3.2 step 0)
// confirms immediate proration nets to ~$0; then flip this default to `invoice`.
const PRORATION_ARG = val("--proration") ?? "next_period";

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

if (PRORATION_ARG !== "invoice" && PRORATION_ARG !== "next_period") {
  fail(`--proration must be invoice or next_period, got ${PRORATION_ARG}`);
}
const PRORATION = PRORATION_ARG as ProrationMode;
if (has("--fixed") && has("--percentage")) fail("Pick one of --fixed / --percentage.");

if (EXECUTE) {
  const server = val("--server");
  if (!server || server !== config.polarServer) {
    fail(`Refusing: --execute needs --server matching POLAR_SERVER (${config.polarServer}).`);
  }
  if (server === "production") {
    if (!has("--yes")) fail("Refusing: --execute against production also needs --yes.");
    console.log("=== PRODUCTION: moving live subscriptions on the Polar production API ===");
  }
}
if (!config.polarAccessToken) fail("POLAR_ACCESS_TOKEN is not set.");
const legacy = { month: config.polarProductMonthlyId, year: config.polarProductYearlyId };
if (!legacy.month && !legacy.year) fail("No legacy product ids (POLAR_PRODUCT_MONTHLY_ID / _YEARLY_ID) set.");
for (const iv of ["month", "year"] as const) {
  if (legacy[iv] && !teamProductId(iv)) fail(`Team product for ${iv} is not set; refusing to plan a move with no target.`);
}

const polar = new Polar({
  accessToken: config.polarAccessToken,
  server: config.polarServer === "production" ? "production" : "sandbox",
});
const provider = new PolarBillingProvider();

/** Refuse the run when a Team product's per-seat price is not the configured one. */
async function preflight(): Promise<void> {
  for (const iv of ["month", "year"] as const) {
    const id = teamProductId(iv);
    if (!id) continue;
    const seat = seatPriceOf(await polar.products.get({ id }));
    if ("error" in seat) fail(`Refusing: Team ${iv} product ${id}: ${seat.error}`);
    if (seat.cents !== teamPricePerSeatCents(iv)) {
      fail(`Refusing: Team ${iv} product ${id} charges ${seat.cents}c per seat, config says ${teamPricePerSeatCents(iv)}c`);
    }
    console.log(`preflight: Team ${iv} ${id} = ${seat.cents}c per seat`);
  }
}

/** Every live legacy sub, cancelling ones included (flagged), unfiltered. */
async function listLegacy(): Promise<LegacySub[]> {
  const out: LegacySub[] = [];
  for (const iv of ["month", "year"] as const) {
    const productId = legacy[iv];
    if (!productId) continue;
    const pages = await polar.subscriptions.list({ productId, active: true, limit: 100 });
    for await (const page of pages) {
      for (const raw of page.result.items as unknown as Array<Record<string, unknown>>) {
        const meta = (raw.metadata ?? {}) as Record<string, unknown>;
        const end = raw.currentPeriodEnd;
        out.push({
          id: String(raw.id),
          interval: iv,
          amount: Number(raw.amount ?? 0),
          currency: String(raw.currency ?? "usd"),
          accountId: meta.billing_account_id ? String(meta.billing_account_id) : null,
          discountId: raw.discountId ? String(raw.discountId) : null,
          currentPeriodEnd: end instanceof Date ? end.toISOString() : end ? String(end) : null,
          cancelAtPeriodEnd: !!raw.cancelAtPeriodEnd,
        });
      }
    }
  }
  // Our row is the authority for which account a subscription pays for.
  const ids = out.map((s) => s.id);
  if (ids.length) {
    const { rows } = await pool.query<{ provider_subscription_id: string; billing_account_id: string | null }>(
      `SELECT provider_subscription_id, billing_account_id FROM subscriptions
        WHERE provider_subscription_id = ANY($1::text[])`,
      [ids],
    );
    const byId = new Map(rows.map((r) => [r.provider_subscription_id, r.billing_account_id]));
    for (const s of out) s.accountId = byId.get(s.id) ?? s.accountId;
  }
  return out;
}

const deps: ExecuteDeps = {
  createDiscount: (args) => provider.createDiscount(args),
  changeProduct: (id, product, proration, discountId) => provider.changeProduct(id, product, proration, discountId),
  updateSeats: (id, seats, proration) => provider.updateSeats(id, seats, proration),
  getRaw: async (id) => toRawSubView(await polar.subscriptions.get({ id })),
  cancelSubscription: (id, mode) => provider.cancelSubscription(id, mode),
  log: (line) => console.log(line),
};

async function main(): Promise<void> {
  console.log(
    `server=${config.polarServer} sum=--${SUM_MODE} discount=${MODE} proration=${PRORATION}` +
      `${ONLY ? ` only=${ONLY}` : ""} ${EXECUTE ? "EXECUTE" : "DRY RUN"}`,
  );
  await preflight();
  const subs = await listLegacy();
  const byAccount = new Map<string, LegacySub[]>();
  for (const s of subs) {
    if (!s.accountId) {
      console.log(`SKIP ${s.id}: no billing account (not in our DB, no metadata) - check by hand`);
      continue;
    }
    byAccount.set(s.accountId, [...(byAccount.get(s.accountId) ?? []), s]);
  }
  if (ONLY) {
    const target = subs.find((s) => s.id === ONLY);
    if (!target?.accountId) fail(`--only ${ONLY}: not a live legacy sub with a billing account`);
    for (const k of [...byAccount.keys()]) if (k !== target.accountId) byAccount.delete(k);
  }

  const perSeatCents: Record<Interval, number> = {
    month: teamPricePerSeatCents("month"),
    year: teamPricePerSeatCents("year"),
  };
  const teamProducts: Record<Interval, string | null> = {
    month: teamProductId("month") ?? null,
    year: teamProductId("year") ?? null,
  };
  const counts = { moved: 0, already: 0, planned: 0, refused: 0, failed: 0, skipped: 0 };
  for (const [accountId, accountSubs] of byAccount) {
    const plan = planAccount({
      accountId,
      subs: accountSubs,
      people: await countAccountPeople(pool, accountId),
      pending: await countPendingInvites(pool, accountId),
      minSeats: teamMinSeats(),
      perSeatCents,
      teamProducts,
      mode: MODE,
      sumMode: SUM_MODE,
      only: ONLY,
    });
    if (isRefusal(plan)) {
      console.log(`\n${plan.refusal}`);
      counts.skipped++;
      continue;
    }
    console.log(`\n${describePlan(plan)}`);
    if (plan.target > plan.list) console.log("  note: today's price is ABOVE Team list; no discount, owner pays less");
    for (const o of plan.others) {
      console.log(`  other legacy sub ${o.id} amount=${o.amount} ends=${o.currentPeriodEnd ?? "?"}${o.cancelAtPeriodEnd ? " (already cancelling)" : " (cancel at period end after verify)"}`);
    }
    counts[await executeAccount(plan, deps, { proration: PRORATION, dryRun: !EXECUTE })]++;
  }
  console.log(
    `\naccounts=${byAccount.size} moved=${counts.moved} already=${counts.already} refused=${counts.refused}` +
      ` failed=${counts.failed} skipped=${counts.skipped}${EXECUTE ? "" : ` planned=${counts.planned} (dry run: nothing sent)`}`,
  );
  if (counts.refused || counts.failed) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error((e as Error).message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
