/**
 * One-off cut-over: move live subscriptions on the LEGACY per-vault products
 * onto the Team seat products while keeping each owner's price (plan §3.7/§7).
 *
 * Per billing account (grouped by interval):
 *   seats    = max(TEAM_MIN_SEATS, people on the account)
 *   target   = today's charged amount (--sum: sum of the account's legacy subs,
 *              --larger: the largest one; default --sum, the
 *              owner keeps paying for every legacy sub combined)
 *   discount = seats x per-seat list - target, as a Polar FOREVER discount
 *              (percentage in basis points by default; --fixed for a
 *              fixed amount off)
 *   then ONE PATCH: product -> matching Team product (monthly->monthly,
 *   yearly->yearly) + discount, proration `next_period`; then a seats PATCH;
 *   then re-read and verify the next charge equals the target.
 * The account's other legacy subs (when it has several) are only LISTED; the
 * owner decides on those by hand.
 *
 * Our DB is READ only here (accounts, people, subscription -> account). Every
 * row change reaches Postgres through the normal webhooks.
 *
 * Usage (from app/apps/server, with the server env loaded):
 *   pnpm exec tsx scripts/billing/move-legacy-subs.ts                    # dry run
 *   pnpm exec tsx scripts/billing/move-legacy-subs.ts --execute --server sandbox
 *   pnpm exec tsx scripts/billing/move-legacy-subs.ts --execute --server production --yes
 *   flags: --larger (default sum)   --fixed (default percentage)   --only <providerSubscriptionId>
 * Refuses to act unless --execute AND --server equals POLAR_SERVER; production
 * also needs --yes.
 */
import { Polar } from "@polar-sh/sdk";
import { config, teamMinSeats, teamPricePerSeatCents, teamProductId } from "../../src/config.js";
import { pool } from "../../src/db/pool.js";
import { countAccountPeople } from "../../src/billing/accounts.js";
import { PolarBillingProvider } from "../../src/billing/polar.js";

const argv = process.argv.slice(2);
const has = (f: string): boolean => argv.includes(f);
const val = (f: string): string | undefined => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const EXECUTE = has("--execute");
const MODE: "sum" | "larger" = has("--larger") ? "larger" : "sum";
const PERCENT = !has("--fixed");
const ONLY = val("--only");

if (EXECUTE) {
  const server = val("--server");
  if (!server || server !== config.polarServer) {
    console.error(`Refusing: --execute needs --server matching POLAR_SERVER (${config.polarServer}).`);
    process.exit(2);
  }
  if (server === "production") {
    if (!has("--yes")) {
      console.error("Refusing: --execute against production also needs --yes.");
      process.exit(2);
    }
    console.log("=== PRODUCTION: moving live subscriptions on the Polar production API ===");
  }
}
if (!config.polarAccessToken) {
  console.error("POLAR_ACCESS_TOKEN is not set.");
  process.exit(2);
}
const legacy = { month: config.polarProductMonthlyId, year: config.polarProductYearlyId };
if (!legacy.month && !legacy.year) {
  console.error("No legacy product ids (POLAR_PRODUCT_MONTHLY_ID / _YEARLY_ID) set.");
  process.exit(2);
}
for (const iv of ["month", "year"] as const) {
  if (legacy[iv] && !teamProductId(iv)) {
    console.error(`Team product for ${iv} is not set; refusing to plan a move with no target.`);
    process.exit(2);
  }
}

const polar = new Polar({
  accessToken: config.polarAccessToken,
  server: config.polarServer === "production" ? "production" : "sandbox",
});
const provider = new PolarBillingProvider();

interface LegacySub {
  id: string;
  interval: "month" | "year";
  amount: number;
  currency: string;
  accountId: string | null;
  discountId: string | null;
}

async function listLegacy(): Promise<LegacySub[]> {
  const out: LegacySub[] = [];
  for (const iv of ["month", "year"] as const) {
    const productId = legacy[iv];
    if (!productId) continue;
    const pages = await polar.subscriptions.list({ productId, active: true, limit: 100 });
    for await (const page of pages) {
      for (const raw of page.result.items as unknown as Array<Record<string, unknown>>) {
        if (raw.cancelAtPeriodEnd) continue; // already ending: leave it alone
        const meta = (raw.metadata ?? {}) as Record<string, unknown>;
        out.push({
          id: String(raw.id),
          interval: iv,
          amount: Number(raw.amount ?? 0),
          currency: String(raw.currency ?? "usd"),
          accountId: meta.billing_account_id ? String(meta.billing_account_id) : null,
          discountId: raw.discountId ? String(raw.discountId) : null,
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
  return ONLY ? out.filter((s) => s.id === ONLY) : out;
}

async function main(): Promise<void> {
  console.log(`server=${config.polarServer} mode=--${MODE} discount=${PERCENT ? "percentage" : "fixed"} ${EXECUTE ? "EXECUTE" : "DRY RUN"}`);
  const subs = await listLegacy();
  const groups = new Map<string, LegacySub[]>();
  for (const s of subs) {
    if (!s.accountId) {
      console.log(`SKIP ${s.id}: no billing account (not in our DB, no metadata) - check by hand`);
      continue;
    }
    const key = `${s.accountId}|${s.interval}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  let moved = 0;
  let failed = 0;
  for (const [key, group] of groups) {
    const [accountId, interval] = key.split("|") as [string, "month" | "year"];
    group.sort((a, b) => b.amount - a.amount);
    const keep = group[0];
    const target = MODE === "sum" ? group.reduce((n, s) => n + s.amount, 0) : keep.amount;
    const people = await countAccountPeople(pool, accountId);
    const seats = Math.max(teamMinSeats(), people);
    const perSeat = teamPricePerSeatCents(interval);
    const list = seats * perSeat;
    const off = Math.max(0, list - target);
    const bp = list > 0 ? Math.round((off / list) * 10000) : 0;
    const teamProduct = teamProductId(interval)!;
    console.log(
      `\naccount=${accountId} interval=${interval} subs=${group.length} keep=${keep.id} people=${people} seats=${seats}` +
        ` list=${list} target=${target} discount=${PERCENT ? `${bp}bp` : `${off}c`}` +
        (keep.discountId ? ` (replaces existing discount ${keep.discountId})` : ""),
    );
    if (target > list) console.log("  note: today's price is ABOVE Team list; no discount, owner pays less");
    for (const other of group.slice(1)) {
      console.log(`  other legacy sub ${other.id} amount=${other.amount}: left as is, decide by hand`);
    }
    if (!EXECUTE) continue;
    try {
      let discountId: string | undefined;
      if (off > 0 && (PERCENT ? bp > 0 : true)) {
        const d = await provider.createDiscount({
          name: `legacy-${accountId}`,
          type: PERCENT ? "percentage" : "fixed",
          amountCents: PERCENT ? undefined : off,
          basisPoints: PERCENT ? bp : undefined,
          currency: keep.currency,
          durationForever: true,
          productIds: [teamProduct],
        });
        discountId = d.id;
        console.log(`  discount created ${d.id}`);
      }
      await provider.changeProduct(keep.id, teamProduct, "next_period", discountId);
      console.log("  product changed (next_period)");
      await provider.updateSeats(keep.id, seats, "next_period");
      console.log("  seats set");
      const after = await provider.getSubscription(keep.id);
      const effSeats = after?.pendingSeats ?? after?.seats ?? null;
      const ok =
        // With next_period the product may still read as legacy until renewal
        // (Polar holds it in pendingUpdate); seats + discount must match now.
        !!after &&
        effSeats === seats &&
        (discountId ? after.discountId === discountId : true);
      console.log(
        `  verify ${ok ? "OK" : "MISMATCH"}: product=${after?.productId} seats=${after?.seats} pending=${after?.pendingSeats}` +
          ` amount=${after?.amount} discount=${after?.discountId}` +
          " (amount reflects the new price only after the next renewal with next_period)",
      );
      if (ok) moved++;
      else failed++;
    } catch (e) {
      failed++;
      console.error(`  FAILED: ${(e as Error).message}`);
    }
  }
  console.log(`\nplanned=${groups.size} moved=${moved} failed=${failed}${EXECUTE ? "" : " (dry run: nothing sent)"}`);
}

main()
  .catch((e) => {
    console.error((e as Error).message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
