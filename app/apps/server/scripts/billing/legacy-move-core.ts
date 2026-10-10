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
  /** Polar customer id; used to find a Team subscription the account already holds. */
  customerId: string | null;
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
  /** Post-discount charge per period Polar reports (minor units); absent when not reported. */
  amount?: number;
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
  mode: "fixed" | "percentage";
  /** --allow-lower: today's charge is above Team list, moved with no discount. */
  lower: boolean;
  teamProduct: string;
  /** Every configured Team product id, both intervals. */
  teamProductIds: string[];
  currency: string;
}

export interface PlanRefusal {
  accountId: string;
  refusal: string;
  /** `leaving`: every sub already ends at period end; nothing to move, not an error. */
  kind: "refused" | "leaving";
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
  /** `--allow-lower`: move an account whose charge is above Team list with no discount. */
  allowLower?: boolean;
}

export const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

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
  const refuse = (refusal: string, kind: PlanRefusal["kind"] = "refused"): PlanRefusal => ({
    accountId,
    refusal,
    kind,
  });
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
      return refuse(`SKIP account ${accountId}: every legacy sub ends at period end (leaving); nothing to move`, "leaving");
    }
    interval = live[0].interval;
  }

  const group = subs.filter((s) => s.interval === interval);
  const liveGroup = group.filter((s) => !s.cancelAtPeriodEnd);
  if (!liveGroup.length) {
    return refuse(`SKIP account ${accountId}: every ${interval}ly legacy sub ends at period end (leaving)`, "leaving");
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
  const lower = target > list;
  if (lower && !input.allowLower) {
    return refuse(
      `SKIP account ${accountId}: today's charge ${dollars(target)} exceeds Team list ${dollars(list)} for ` +
        `${seats} seats; pass --allow-lower to move it with no discount`,
    );
  }
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
    mode: input.mode,
    lower,
    teamProduct,
    teamProductIds: [input.teamProducts.month, input.teamProducts.year].filter((x): x is string => !!x),
    currency: keep.currency,
  };
}

/**
 * A legacy product is not seat-based and the Team one is: Polar refuses
 * `next_period` for that switch ("must apply immediately"), so the product
 * change is ALWAYS `invoice`, whatever was requested.
 */
export const PRODUCT_CHANGE_PRORATION: ProrationMode = "invoice";

export function describePlan(p: AccountPlan, requested?: ProrationMode): string {
  const d = p.discount
    ? p.discount.type === "fixed"
      ? `fixed ${p.discount.amount}c`
      : `${p.discount.bp}bp`
    : "none";
  return (
    `account=${p.accountId} interval=${p.interval} subs=${p.others.length + 1} keep=${p.keep.id}` +
    ` people=${p.people} pending=${p.pending} seats=${p.seats} list=${p.list} target=${p.target}` +
    ` discount=${d} expected=${p.expected}` +
    (p.lower ? ` LOWER: --allow-lower, owner pays ${dollars(p.list)} instead of ${dollars(p.target)}` : "") +
    (p.keep.discountId ? ` (replaces existing discount ${p.keep.discountId})` : "") +
    ` proration=${PRODUCT_CHANGE_PRORATION} (product change + seats PATCH)` +
    (requested && requested !== PRODUCT_CHANGE_PRORATION
      ? ` (requested ${requested}: Polar refuses it for a non-seat to seat change)`
      : "")
  );
}

/** A Polar discount as the reuse check reads it (`discounts.list`). */
export interface ExistingDiscount {
  id: string;
  name: string;
  type: string;
  duration: string;
  amount: number | null;
  currency: string | null;
  basisPoints: number | null;
  productIds: string[];
  redemptions: number;
}

export interface ExecuteDeps {
  /** Discounts whose name is exactly `name` (read only). */
  listDiscounts(name: string): Promise<ExistingDiscount[]>;
  deleteDiscount(id: string): Promise<unknown>;
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

export type ExecuteStatus = "moved" | "scheduled" | "planned" | "refused" | "failed";

/** Does an existing `legacy-<acct>` discount equal what the plan would create? */
export function discountMatchesPlan(plan: AccountPlan, d: ExistingDiscount): boolean {
  const pd = plan.discount;
  if (!pd || d.name !== `legacy-${plan.accountId}` || d.duration !== "forever") return false;
  if (d.productIds.length !== 1 || d.productIds[0] !== plan.teamProduct) return false;
  if (pd.type === "fixed") {
    return (
      d.type === "fixed" &&
      d.amount === pd.amount &&
      (d.currency ?? "").toLowerCase() === plan.currency.toLowerCase()
    );
  }
  return d.type === "percentage" && d.basisPoints === pd.bp;
}

const describeDiscount = (d: ExistingDiscount): string =>
  `${d.type} ${d.type === "percentage" ? `${d.basisPoints}bp` : `${d.amount}c`} ${d.duration}` +
  ` products=${d.productIds.join(",") || "none"} redemptions=${d.redemptions}`;

/** Map a raw SDK discount (camelCase) to the fields the reuse check reads. */
export function toExistingDiscount(raw: unknown): ExistingDiscount {
  const d = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  return {
    id: String(d.id),
    name: String(d.name ?? ""),
    type: String(d.type ?? ""),
    duration: String(d.duration ?? ""),
    amount: num(d.amount),
    currency: d.currency ? String(d.currency) : null,
    basisPoints: num(d.basisPoints),
    productIds: ((d.products ?? []) as Array<Record<string, unknown>>).map((x) => String(x.id)),
    redemptions: num(d.redemptionsCount) ?? 0,
  };
}

type DiscountDecision =
  | { kind: "none" }
  | { kind: "reuse"; id: string; stale: ExistingDiscount[] }
  | { kind: "create"; stale: ExistingDiscount[] }
  | { kind: "refuse"; reason: string };

/**
 * Reuse a matching `legacy-<acct>` discount (an earlier run created it and then
 * failed); a mismatched one is stale and replaced, unless someone redeemed it or
 * it is the keeper's own discount (then the owner finishes by hand).
 */
async function decideDiscount(plan: AccountPlan, before: RawSubView, deps: ExecuteDeps): Promise<DiscountDecision> {
  if (!plan.discount) return { kind: "none" };
  const name = `legacy-${plan.accountId}`;
  const found = (await deps.listDiscounts(name)).filter((d) => d.name === name);
  const match = found.find((d) => discountMatchesPlan(plan, d));
  const stale = found.filter((d) => !discountMatchesPlan(plan, d));
  const blocked = stale.find((d) => d.redemptions > 0 || d.id === before.discount?.id);
  if (blocked) {
    return { kind: "refuse", reason: `stale discount ${blocked.id} (${describeDiscount(blocked)}) is in use; finish by hand` };
  }
  return match ? { kind: "reuse", id: match.id, stale } : { kind: "create", stale };
}

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
export function verifyProblems(
  plan: AccountPlan,
  raw: RawSubView,
  scheduledBefore: boolean,
  immediate = false,
): string[] {
  const out: string[] = [];
  if (immediate) {
    // An immediate change must already be CURRENT, not pending, and Polar's own
    // post-discount amount must be the planned charge.
    if (raw.productId !== plan.teamProduct) out.push(`current product ${raw.productId} is not Team ${plan.teamProduct}`);
    if (raw.pendingProductId !== null) out.push(`product change still pending (${raw.pendingProductId})`);
    if (raw.seats !== plan.seats) out.push(`current seats ${raw.seats} != planned ${plan.seats}`);
    if (raw.amount === undefined) out.push("Polar did not report the subscription amount");
    else if (raw.amount !== plan.expected) out.push(`Polar amount ${raw.amount} != planned ${plan.expected}`);
  }
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
  // A fixed plan keeps today's price exactly; only --allow-lower may charge less.
  if (plan.mode === "fixed" && !plan.lower && charge !== plan.target) {
    out.push(`expected charge ${charge} != target ${plan.target}`);
  }
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
    const eff = effProduct(before);
    if (!scheduled && eff !== null && eff !== plan.teamProduct && plan.teamProductIds.includes(eff)) {
      log(`  REFUSED: ${keepId} is already moving to Team product ${eff} of the other interval; finish by hand`);
      return "refused";
    }
    if (!scheduled && eff === plan.teamProduct) {
      // Polar may hold the discount in the pending update, which the SDK does not
      // expose: never change the product again and never create a second discount.
      log("  product change pending; discount not visible yet, re-run after renewal to verify (nothing changed, nothing cancelled)");
      return "scheduled";
    }
    const changeProduct = !scheduled;
    if (changeProduct && opts.proration !== PRODUCT_CHANGE_PRORATION) {
      log(
        `  WARNING: --proration ${opts.proration} ignored for the product change and its seats PATCH;` +
          ` Polar requires ${PRODUCT_CHANGE_PRORATION} when switching a non-seat product to a seat product`,
      );
    }
    const seatsProration: ProrationMode = changeProduct ? PRODUCT_CHANGE_PRORATION : opts.proration;
    const decision = changeProduct ? await decideDiscount(plan, before, deps) : ({ kind: "none" } as const);
    if (decision.kind === "refuse") {
      log(`  REFUSED: ${decision.reason}; nothing changed`);
      return "refused";
    }

    if (opts.dryRun) {
      if (scheduled) log(`  already scheduled: product + discount skipped (target not recomputed)`);
      else {
        if (decision.kind === "reuse" || decision.kind === "create") {
          for (const d of decision.stale) log(`  would replace stale discount ${d.id} (${describeDiscount(d)})`);
          log(decision.kind === "reuse" ? `  would reuse discount ${decision.id}` : "  would create discount");
        }
        log(`  would change product (${PRODUCT_CHANGE_PRORATION})`);
      }
      if (changeProduct) log(`  would set seats -> ${plan.seats} (${seatsProration}) in a second PATCH`);
      else if (effSeats(before) !== plan.seats) log(`  would set seats ${effSeats(before)} -> ${plan.seats} (${seatsProration})`);
      for (const o of toCancel) log(`  would cancel ${o.id} at period end after verify`);
      return "planned";
    }

    if (scheduled) {
      log("  already scheduled: discount + product skipped");
    } else {
      let discountId: string | undefined;
      if (decision.kind === "reuse" || decision.kind === "create") {
        for (const d of decision.stale) {
          await deps.deleteDiscount(d.id);
          log(`  replacing stale discount ${d.id} (${describeDiscount(d)}): deleted`);
        }
      }
      if (decision.kind === "reuse") {
        discountId = decision.id;
        log(`  reusing discount ${decision.id}`);
      } else if (decision.kind === "create" && plan.discount) {
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
      await deps.changeProduct(keepId, plan.teamProduct, PRODUCT_CHANGE_PRORATION, discountId);
      log(`  product changed (${PRODUCT_CHANGE_PRORATION})`);
    }

    // Polar's update body is a union: `seats` cannot ride in the product PATCH.
    const mid = scheduled ? before : await deps.getRaw(keepId);
    if (changeProduct || !mid || effSeats(mid) !== plan.seats) {
      if (changeProduct) {
        log(
          `  seats PATCH follows the product change (${seatsProration}): Polar may issue TWO proration invoices;` +
            " the owner must check both at Polar",
        );
      }
      if (!mid || effSeats(mid) !== plan.seats) {
        await deps.updateSeats(keepId, plan.seats, seatsProration);
        log(`  seats set ${plan.seats} (${seatsProration})`);
      } else {
        log(`  seats already ${plan.seats} after the product change`);
      }
    }

    const after = await deps.getRaw(keepId);
    if (!after) {
      log(`  MISMATCH: ${keepId} vanished on re-read; nothing cancelled`);
      return "refused";
    }
    const problems = verifyProblems(plan, after, scheduled, changeProduct);
    const charge = chargeOf(plan, after);
    if (problems.length) {
      log(`  verify MISMATCH: ${problems.join("; ")}; target=${plan.target} expected=${charge}; nothing cancelled`);
      return "refused";
    }
    log(
      `  verify OK: product=${effProduct(after)} seats=${effSeats(after)} discount=${after.discount?.type ?? "none"}` +
        ` ${scheduled ? `expected=${charge} (already scheduled, target not recomputed)` : `target=${plan.target} expected=${charge}`}` +
        (after.amount !== undefined ? ` polarAmount=${after.amount}` : ""),
    );
    if (changeProduct) {
      log(`  proration invoice: not exposed by the subscription read; the owner must check ${keepId}'s invoices at Polar`);
    }
    for (const o of toCancel) {
      await deps.cancelSubscription(o.id, "period_end");
      log(`  cancelled ${o.id} at period end (amount=${o.amount} ends ${o.currentPeriodEnd ?? "?"})`);
    }
    for (const o of plan.others.filter((x) => x.cancelAtPeriodEnd)) {
      log(`  ${o.id} already ends at period end`);
    }
    return scheduled ? "scheduled" : "moved";
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
    ...(typeof s.amount === "number" ? { amount: s.amount } : {}),
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

/** A subscription of the account's Polar customer(s), as the guard reads it. */
export interface CustomerSubView {
  id: string;
  productId: string | null;
  pendingProductId: string | null;
}

export interface RunDeps extends ExecuteDeps {
  /** Active subs of these Polar customers, plus any Team sub tagged with this account. Read only. */
  listCustomerSubs(customerIds: string[], accountId: string): Promise<CustomerSubView[]>;
  /** Our `subscriptions` rows of this account a Team move wrote (seats set or a `legacy-` discount). */
  dbTeamRows(accountId: string): Promise<string[]>;
}

export type RunStatus = ExecuteStatus | "skipped-leaving";

/**
 * Why this account must not be planned: it already holds a Team subscription
 * that is not one of its legacy subs (an earlier run moved the keeper with
 * immediate proration). Planning it again would pick a leftover as the keeper,
 * sum only the leftovers and create a SECOND Team subscription.
 */
export async function existingTeamRefusal(
  accountId: string,
  subs: LegacySub[],
  teamProductIds: string[],
  deps: Pick<RunDeps, "listCustomerSubs" | "dbTeamRows">,
): Promise<string | null> {
  const legacyIds = new Set(subs.map((s) => s.id));
  const customers = [...new Set(subs.map((s) => s.customerId).filter((c): c is string => !!c))];
  const listed = await deps.listCustomerSubs(customers, accountId);
  const team = listed.find(
    (s) =>
      !legacyIds.has(s.id) &&
      ((s.productId !== null && teamProductIds.includes(s.productId)) ||
        (s.pendingProductId !== null && teamProductIds.includes(s.pendingProductId))),
  );
  if (team) return `REFUSED account ${accountId}: already holds Team subscription ${team.id}; finish by hand`;
  // Rows of the legacy subs listed now are the keeper's own pending change: the
  // executor's scheduled guard owns those.
  const rows = (await deps.dbTeamRows(accountId)).filter((id) => !legacyIds.has(id));
  if (rows.length) {
    return `REFUSED account ${accountId}: already holds Team subscription ${rows[0]} (our DB); finish by hand`;
  }
  return null;
}

/** Guard, plan and execute one account; every line goes through `deps.log`. */
export async function runAccount(
  input: PlanInput,
  deps: RunDeps,
  opts: ExecuteOptions,
): Promise<RunStatus> {
  const teamProductIds = [input.teamProducts.month, input.teamProducts.year].filter((x): x is string => !!x);
  const guard = await existingTeamRefusal(input.accountId, input.subs, teamProductIds, deps);
  if (guard) {
    deps.log(`\n${guard}`);
    return "refused";
  }
  const plan = planAccount(input);
  if (isRefusal(plan)) {
    deps.log(`\n${plan.refusal}`);
    return plan.kind === "leaving" ? "skipped-leaving" : "refused";
  }
  deps.log(`\n${describePlan(plan, opts.proration)}`);
  if (plan.lower) {
    deps.log(
      `  WARNING --allow-lower: today's charge ${dollars(plan.target)} is ABOVE Team list ${dollars(plan.list)};` +
        " moving with NO discount, the owner pays less",
    );
  }
  for (const o of plan.others) {
    deps.log(
      `  other legacy sub ${o.id} amount=${o.amount} ends=${o.currentPeriodEnd ?? "?"}` +
        (o.cancelAtPeriodEnd ? " (already cancelling)" : " (cancel at period end after verify)"),
    );
  }
  return executeAccount(plan, deps, opts);
}
