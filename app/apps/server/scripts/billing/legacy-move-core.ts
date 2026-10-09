/**
 * Pure planner + executor for `move-legacy-subs.ts` (plan §3.1). No Polar
 * client and no database here: the script injects both, the test injects
 * `vi.fn`s.
 */

export type Interval = "month" | "year";
export type ProrationMode = "invoice" | "next_period";

/** One live subscription on a LEGACY per-vault product, as listed at Polar. */
export interface LegacySub {
  id: string;
  interval: Interval;
  /** Charged amount per period, minor units. */
  amount: number;
  currency: string;
  accountId: string | null;
  discountId: string | null;
  /** ISO timestamp; null when Polar did not report one. */
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

/** The fields of a raw `polar.subscriptions.get` the executor reads. */
export interface RawSubView {
  productId: string | null;
  pendingProductId: string | null;
  seats: number | null;
  pendingSeats: number | null;
  cancelAtPeriodEnd: boolean;
  discount: {
    id: string;
    name: string;
    type: string;
    amount: number | null;
    basisPoints: number | null;
  } | null;
}

export type PlannedDiscount =
  | { type: "fixed"; amount: number }
  | { type: "percentage"; bp: number };

export interface AccountPlan {
  accountId: string;
  interval: Interval;
  keep: LegacySub;
  /** Every other sub of the group, cancelling ones included (bookkeeping). */
  others: LegacySub[];
  people: number;
  pending: number;
  seats: number;
  perSeat: number;
  list: number;
  target: number;
  discount: PlannedDiscount | null;
  /** list - discount: what the owner is charged after the move. */
  expected: number;
  teamProduct: string;
  currency: string;
}

export interface PlanRefusal {
  accountId: string;
  refusal: string;
}

export type PlanResult = AccountPlan | PlanRefusal;

export const isRefusal = (p: PlanResult): p is PlanRefusal => "refusal" in p;

export interface PlanInput {
  accountId: string;
  /** EVERY legacy sub of the account, both intervals, cancelling ones too. */
  subs: LegacySub[];
  people: number;
  pending: number;
  minSeats: number;
  perSeatCents: Record<Interval, number>;
  teamProducts: Record<Interval, string | null>;
  mode: "fixed" | "percentage";
  sumMode: "sum" | "larger";
  /** `--only <providerSubId>`: plan that sub's interval group of this account. */
  only?: string;
}

const periodEndMs = (s: LegacySub): number =>
  s.currentPeriodEnd ? Date.parse(s.currentPeriodEnd) || 0 : 0;

/** Latest period end wins (no double charge, no gap); tie ⇒ larger amount; then id. */
export function pickKeep(live: LegacySub[]): LegacySub {
  return [...live].sort(
    (a, b) => periodEndMs(b) - periodEndMs(a) || b.amount - a.amount || a.id.localeCompare(b.id),
  )[0];
}

export const percentOff = (list: number, bp: number): number => Math.round((list * bp) / 10000);

export function planAccount(input: PlanInput): PlanResult {
  const { accountId, subs } = input;
  const refuse = (refusal: string): PlanRefusal => ({ accountId, refusal });
  const live = subs.filter((s) => !s.cancelAtPeriodEnd);

  let interval: Interval;
  if (input.only) {
    const picked = subs.find((s) => s.id === input.only);
    if (!picked) return refuse(`SKIP account ${accountId}: --only ${input.only} is not one of its legacy subs`);
    interval = picked.interval;
  } else {
    const monthly = live.filter((s) => s.interval === "month");
    const yearly = live.filter((s) => s.interval === "year");
    if (monthly.length && yearly.length) {
      return refuse(
        `SKIP account ${accountId}: monthly ${monthly.map((s) => s.id).join(",")} and yearly ` +
          `${yearly.map((s) => s.id).join(",")}; move one with --only`,
      );
    }
    if (!live.length) {
      return refuse(`SKIP account ${accountId}: every legacy sub ends at period end (leaving); nothing to move`);
    }
    interval = live[0].interval;
  }

  const group = subs.filter((s) => s.interval === interval);
  const liveGroup = group.filter((s) => !s.cancelAtPeriodEnd);
  if (!liveGroup.length) {
    return refuse(`SKIP account ${accountId}: every ${interval}ly legacy sub ends at period end (leaving)`);
  }
  const currencies = new Set(liveGroup.map((s) => s.currency.toLowerCase()));
  if (currencies.size > 1) {
    return refuse(`SKIP account ${accountId}: mixed currencies ${[...currencies].join(",")}`);
  }
  const teamProduct = input.teamProducts[interval];
  if (!teamProduct) return refuse(`SKIP account ${accountId}: no Team product for ${interval}`);

  const keep = pickKeep(liveGroup);
  const others = group.filter((s) => s.id !== keep.id);
  const target =
    input.sumMode === "sum"
      ? liveGroup.reduce((n, s) => n + s.amount, 0)
      : Math.max(...liveGroup.map((s) => s.amount));
  const seats = Math.max(input.minSeats, input.people + input.pending);
  const perSeat = input.perSeatCents[interval];
  const list = seats * perSeat;
  const off = Math.max(0, list - target);

  let discount: PlannedDiscount | null = null;
  let expected = list;
  if (input.mode === "fixed") {
    // A $0 sub (target 0) gets a discount equal to the full list.
    if (off > 0) discount = { type: "fixed", amount: off };
    expected = list - off;
  } else {
    const bp = list > 0 ? Math.round((off / list) * 10000) : 0;
    if (bp > 0) discount = { type: "percentage", bp };
    expected = list - percentOff(list, bp);
  }
  return {
    accountId,
    interval,
    keep,
    others,
    people: input.people,
    pending: input.pending,
    seats,
    perSeat,
    list,
    target,
    discount,
    expected,
    teamProduct,
    currency: keep.currency,
  };
}

export function describePlan(p: AccountPlan): string {
  const d = p.discount
    ? p.discount.type === "fixed"
      ? `fixed ${p.discount.amount}c`
      : `${p.discount.bp}bp`
    : "none";
  return (
    `account=${p.accountId} interval=${p.interval} subs=${p.others.length + 1} keep=${p.keep.id}` +
    ` people=${p.people} pending=${p.pending} seats=${p.seats} list=${p.list} target=${p.target}` +
    ` discount=${d} expected=${p.expected}` +
    (p.keep.discountId ? ` (replaces existing discount ${p.keep.discountId})` : "")
  );
}

export interface ExecuteDeps {
  createDiscount(args: {
    name: string;
    type: "fixed" | "percentage";
    amountCents?: number;
    basisPoints?: number;
    currency: string;
    durationForever: true;
    productIds: string[];
  }): Promise<{ id: string }>;
  changeProduct(subId: string, productId: string, proration: ProrationMode, discountId?: string): Promise<unknown>;
  updateSeats(subId: string, seats: number, proration: ProrationMode): Promise<unknown>;
  getRaw(subId: string): Promise<RawSubView | null>;
  cancelSubscription(subId: string, mode: "period_end"): Promise<unknown>;
  log(line: string): void;
}

export interface ExecuteOptions {
  proration: ProrationMode;
  dryRun?: boolean;
}

export type ExecuteStatus = "moved" | "already" | "planned" | "refused" | "failed";

const effProduct = (r: RawSubView): string | null => r.pendingProductId ?? r.productId;
const effSeats = (r: RawSubView): number | null => r.pendingSeats ?? r.seats;

/** A keeper an earlier run already moved: Team product + our `legacy-` discount (or none needed). */
export function isScheduled(plan: AccountPlan, raw: RawSubView): boolean {
  if (effProduct(raw) !== plan.teamProduct) return false;
  if (raw.discount) return raw.discount.name.startsWith("legacy-");
  return plan.discount === null;
}

/** What the re-read subscription will charge: seats × per-seat − its discount. */
export function chargeOf(plan: AccountPlan, raw: RawSubView): number | null {
  const seats = effSeats(raw);
  if (seats === null) return null;
  const list = seats * plan.perSeat;
  const d = raw.discount;
  if (!d) return list;
  if (d.type === "fixed") return d.amount === null ? null : Math.max(0, list - d.amount);
  if (d.type === "percentage") return d.basisPoints === null ? null : list - percentOff(list, d.basisPoints);
  return null;
}

/** Every reason the re-read does not match the plan; empty means verified. */
export function verifyProblems(plan: AccountPlan, raw: RawSubView, scheduledBefore: boolean): string[] {
  const out: string[] = [];
  if (effProduct(raw) !== plan.teamProduct) out.push(`product ${effProduct(raw)} is not Team ${plan.teamProduct}`);
  if (effSeats(raw) !== plan.seats) out.push(`seats ${effSeats(raw)} != planned ${plan.seats}`);
  const charge = chargeOf(plan, raw);
  if (scheduledBefore) {
    // Never recompute the target for a keeper an earlier run moved.
    if (raw.discount && !raw.discount.name.startsWith("legacy-")) out.push(`discount ${raw.discount.name} is not ours`);
    if (charge === null) out.push("charge cannot be computed from the re-read");
    return out;
  }
  const d = raw.discount;
  const pd = plan.discount;
  if (!pd) {
    if (d) out.push(`unexpected discount ${d.type} ${d.id}`);
  } else if (!d) {
    out.push("no discount attached");
  } else if (pd.type === "fixed") {
    if (d.type !== "fixed") out.push(`discount type ${d.type}, planned fixed`);
    else if (d.amount !== pd.amount) out.push(`discount amount ${d.amount} != planned ${pd.amount}`);
  } else {
    if (d.type !== "percentage") out.push(`discount type ${d.type}, planned percentage`);
    else if (d.basisPoints !== pd.bp) out.push(`discount ${d.basisPoints}bp != planned ${pd.bp}bp`);
  }
  if (charge !== plan.expected) out.push(`expected charge ${charge} != planned ${plan.expected}`);
  if (pd?.type === "fixed" && charge !== plan.target) out.push(`expected charge ${charge} != target ${plan.target}`);
  return out;
}

export async function executeAccount(
  plan: AccountPlan,
  deps: ExecuteDeps,
  opts: ExecuteOptions,
): Promise<ExecuteStatus> {
  const { log } = deps;
  const keepId = plan.keep.id;
  const toCancel = plan.others.filter((o) => !o.cancelAtPeriodEnd);
  try {
    const before = await deps.getRaw(keepId);
    if (!before) {
      log(`  REFUSED: ${keepId} not found at Polar`);
      return "refused";
    }
    const scheduled = isScheduled(plan, before);
    if (opts.dryRun) {
      if (scheduled) log(`  already scheduled: product + discount skipped (target not recomputed)`);
      else log(`  would ${plan.discount ? "create discount, " : ""}change product (${opts.proration})`);
      if (effSeats(before) !== plan.seats) log(`  would set seats ${effSeats(before)} -> ${plan.seats} (${opts.proration})`);
      for (const o of toCancel) log(`  would cancel ${o.id} at period end after verify`);
      return "planned";
    }

    if (scheduled) {
      log("  already scheduled: discount + product skipped");
    } else {
      let discountId: string | undefined;
      if (plan.discount) {
        const d = await deps.createDiscount({
          name: `legacy-${plan.accountId}`,
          type: plan.discount.type,
          amountCents: plan.discount.type === "fixed" ? plan.discount.amount : undefined,
          basisPoints: plan.discount.type === "percentage" ? plan.discount.bp : undefined,
          currency: plan.currency,
          durationForever: true,
          productIds: [plan.teamProduct],
        });
        discountId = d.id;
        log(`  discount created ${d.id}`);
      }
      await deps.changeProduct(keepId, plan.teamProduct, opts.proration, discountId);
      log(`  product changed (${opts.proration})`);
    }

    const mid = scheduled ? before : await deps.getRaw(keepId);
    if (!mid || effSeats(mid) !== plan.seats) {
      await deps.updateSeats(keepId, plan.seats, opts.proration);
      log(`  seats set ${plan.seats} (${opts.proration})`);
    }

    const after = await deps.getRaw(keepId);
    if (!after) {
      log(`  MISMATCH: ${keepId} vanished on re-read; nothing cancelled`);
      return "refused";
    }
    const problems = verifyProblems(plan, after, scheduled);
    const charge = chargeOf(plan, after);
    if (problems.length) {
      log(`  verify MISMATCH: ${problems.join("; ")}; target=${plan.target} expected=${charge}; nothing cancelled`);
      return "refused";
    }
    log(
      `  verify OK: product=${effProduct(after)} seats=${effSeats(after)} discount=${after.discount?.type ?? "none"}` +
        ` ${scheduled ? `expected=${charge} (already scheduled, target not recomputed)` : `target=${plan.target} expected=${charge}`}`,
    );
    for (const o of toCancel) {
      await deps.cancelSubscription(o.id, "period_end");
      log(`  cancelled ${o.id} at period end (amount=${o.amount} ends ${o.currentPeriodEnd ?? "?"})`);
    }
    for (const o of plan.others.filter((x) => x.cancelAtPeriodEnd)) {
      log(`  ${o.id} already ends at period end`);
    }
    return scheduled ? "already" : "moved";
  } catch (e) {
    log(`  FAILED: ${(e as Error).message}`);
    return "failed";
  }
}

/** Map a raw SDK subscription (camelCase) to the fields the executor reads. */
export function toRawSubView(raw: unknown): RawSubView {
  const s = (raw ?? {}) as Record<string, unknown>;
  const pu = (s.pendingUpdate ?? null) as Record<string, unknown> | null;
  const d = (s.discount ?? null) as Record<string, unknown> | null;
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  return {
    productId: s.productId ? String(s.productId) : null,
    pendingProductId: pu?.productId ? String(pu.productId) : null,
    seats: num(s.seats),
    pendingSeats: num(pu?.seats),
    cancelAtPeriodEnd: !!s.cancelAtPeriodEnd,
    discount: d
      ? {
          id: String(d.id),
          name: String(d.name ?? ""),
          type: String(d.type ?? ""),
          amount: num(d.amount),
          basisPoints: num(d.basisPoints),
        }
      : null,
  };
}

/**
 * The per-seat amount of a Team product's seat-based price, or a reason it
 * cannot be trusted (no seat price, several prices, or tiers that differ).
 */
export function seatPriceOf(product: unknown): { cents: number } | { error: string } {
  const p = (product ?? {}) as Record<string, unknown>;
  const prices = ((p.prices ?? []) as Array<Record<string, unknown>>).filter(
    (x) => String(x.amountType ?? x.amount_type) === "seat_based" && !x.isArchived,
  );
  if (prices.length !== 1) return { error: `expected one seat-based price, found ${prices.length}` };
  const tiers = ((prices[0].seatTiers as { tiers?: Array<{ pricePerSeat?: number }> } | undefined)?.tiers ?? []);
  const amounts = new Set(tiers.map((t) => t.pricePerSeat));
  if (amounts.size !== 1) return { error: `seat tiers have ${amounts.size} different prices` };
  const cents = [...amounts][0];
  if (typeof cents !== "number") return { error: "seat tier has no pricePerSeat" };
  return { cents };
}
