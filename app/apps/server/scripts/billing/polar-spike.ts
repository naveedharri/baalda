/**
 * PR 0 sandbox spike for Team seat billing. SANDBOX ONLY, dry-run by default.
 *
 * Answers the questions the legacy-price migration depends on:
 *  (a) do the two Team seat products exist with seat-based prices (min 3)?
 *  (b) on one sandbox subscription: does Polar accept, in order,
 *      1. a product change to the Team monthly product with `next_period`,
 *      2. a seat update,
 *      3. creating a fixed-amount FOREVER discount and attaching it,
 *    and what do seats / discount / amount / pendingUpdate read back as?
 *
 * Usage (from app/apps/server):
 *   POLAR_SERVER=sandbox POLAR_ACCESS_TOKEN=... \
 *   POLAR_PRODUCT_TEAM_MONTHLY_ID=... POLAR_PRODUCT_TEAM_YEARLY_ID=... \
 *   pnpm exec tsx scripts/billing/polar-spike.ts [--subscription <id>] [--seats 4]
 *     [--discount-cents 500] [--execute]
 *
 * Without --execute it only READS (products, the subscription) and prints the
 * PATCH bodies it would send. Refuses to run unless POLAR_SERVER=sandbox.
 * Never prints the token.
 */
import { Polar } from "@polar-sh/sdk";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const EXECUTE = process.argv.includes("--execute");

if (process.env.POLAR_SERVER !== "sandbox") {
  console.error("Refusing: set POLAR_SERVER=sandbox. This spike never runs against production.");
  process.exit(2);
}
const token = process.env.POLAR_ACCESS_TOKEN;
if (!token) {
  console.error("POLAR_ACCESS_TOKEN is not set.");
  process.exit(2);
}
const MONTHLY = process.env.POLAR_PRODUCT_TEAM_MONTHLY_ID;
const YEARLY = process.env.POLAR_PRODUCT_TEAM_YEARLY_ID;
const polar = new Polar({ accessToken: token, server: "sandbox" });

type Outcome = { step: string; ok: boolean; detail: string };
const outcomes: Outcome[] = [];
function record(step: string, ok: boolean, detail: string): void {
  outcomes.push({ step, ok, detail });
  console.log(`${ok ? "ACCEPTED" : "REFUSED "}  ${step}  ${detail}`);
}
function errText(e: unknown): string {
  const x = e as { statusCode?: number; body?: string; message?: string };
  return `HTTP ${x.statusCode ?? "?"} ${(x.body ?? x.message ?? String(e)).slice(0, 400)}`;
}

async function checkProducts(): Promise<void> {
  console.log("\n== (a) Team seat products");
  for (const [label, id] of [
    ["monthly", MONTHLY],
    ["yearly", YEARLY],
  ] as const) {
    if (!id) {
      record(`product ${label}`, false, "env id not set");
      continue;
    }
    try {
      const p = (await polar.products.get({ id })) as unknown as Record<string, unknown>;
      const prices = (p.prices ?? []) as Array<Record<string, unknown>>;
      const seatPrices = prices.filter((x) => String(x.amountType ?? x.amount_type) === "seat_based");
      const summary = seatPrices.map((x) => JSON.stringify({
        amountType: x.amountType,
        priceCurrency: x.priceCurrency,
        seatTiers: x.seatTiers,
        minSeats: (x as { seatTiers?: { minimumSeats?: number } }).seatTiers?.minimumSeats,
      }));
      record(
        `product ${label}`,
        seatPrices.length > 0,
        `name=${String(p.name)} interval=${String(p.recurringInterval)} seatPrices=${seatPrices.length} ${summary.join(" ")}`,
      );
    } catch (e) {
      record(`product ${label}`, false, errText(e));
    }
  }
}

function show(sub: unknown): string {
  const s = sub as Record<string, unknown>;
  const d = s.discount as Record<string, unknown> | null;
  return JSON.stringify({
    productId: s.productId,
    seats: s.seats,
    amount: s.amount,
    currency: s.currency,
    interval: s.recurringInterval,
    discount: d ? { id: d.id, name: d.name, type: d.type, amount: d.amount, duration: d.duration } : null,
    pendingUpdate: s.pendingUpdate,
    currentPeriodEnd: s.currentPeriodEnd,
  });
}

async function trySubscription(id: string): Promise<void> {
  console.log(`\n== (b) subscription ${id} ${EXECUTE ? "(EXECUTE)" : "(dry run)"}`);
  const before = await polar.subscriptions.get({ id });
  console.log("before:", show(before));
  if (!MONTHLY) {
    record("product change", false, "POLAR_PRODUCT_TEAM_MONTHLY_ID not set");
    return;
  }
  const seats = Number(arg("seats") ?? 3);
  const discountCents = Number(arg("discount-cents") ?? 500);
  const plan = [
    { step: "1 changeProduct(next_period)", body: { productId: MONTHLY, prorationBehavior: "next_period" } },
    { step: "2 updateSeats", body: { seats, prorationBehavior: "next_period" } },
    { step: "3 createDiscount(fixed, forever)", body: { name: `spike-legacy-${Date.now()}`, type: "fixed", duration: "forever", amount: discountCents, currency: "usd", products: [MONTHLY] } },
    { step: "4 applyDiscount", body: { discountId: "<from step 3>" } },
  ];
  if (!EXECUTE) {
    for (const p of plan) console.log(`would send  ${p.step}  ${JSON.stringify(p.body)}`);
    return;
  }
  try {
    const s = await polar.subscriptions.update({
      id,
      subscriptionUpdate: { productId: MONTHLY, prorationBehavior: "next_period" },
    });
    record(plan[0].step, true, show(s));
  } catch (e) {
    record(plan[0].step, false, errText(e));
  }
  try {
    const s = await polar.subscriptions.update({
      id,
      subscriptionUpdate: { seats, prorationBehavior: "next_period" },
    });
    record(plan[1].step, true, show(s));
  } catch (e) {
    record(plan[1].step, false, errText(e));
  }
  let discountId: string | null = null;
  try {
    const d = (await polar.discounts.create({
      name: `spike-legacy-${Date.now()}`,
      type: "fixed",
      duration: "forever",
      amount: discountCents,
      currency: "usd" as never,
      products: [MONTHLY],
    })) as { id: string };
    discountId = d.id;
    record(plan[2].step, true, `id=${d.id}`);
  } catch (e) {
    record(plan[2].step, false, errText(e));
  }
  if (discountId) {
    try {
      const s = await polar.subscriptions.update({ id, subscriptionUpdate: { discountId } });
      record(plan[3].step, true, show(s));
    } catch (e) {
      record(plan[3].step, false, errText(e));
    }
  }
  const after = await polar.subscriptions.get({ id });
  console.log("after:", show(after));
}

async function main(): Promise<void> {
  await checkProducts();
  const sub = arg("subscription");
  if (sub) await trySubscription(sub);
  else console.log("\n(no --subscription given: skipped part b)");
  console.log("\n== summary");
  for (const o of outcomes) console.log(`${o.ok ? "ok  " : "FAIL"} ${o.step}`);
}

main().catch((e) => {
  console.error(errText(e));
  process.exit(1);
});
