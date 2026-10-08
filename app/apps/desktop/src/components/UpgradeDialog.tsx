import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { authManager } from "../lib/auth/authManager";
import * as ipc from "../lib/ipc";
import { useStore } from "../store";
import type { MyBillingAccount } from "../lib/api";
import {
  FREE_PLAN_INCLUDES,
  LEGACY_PRO_BENEFITS,
  legacyFreePlanExplanation,
  TEAM_BENEFITS,
  defaultSeats,
  formatMoney,
  yearlySavingsLabel,
} from "../lib/billing";

/** Poll cadence + budget while waiting for the checkout webhook to land. */
const POLL_INTERVAL_MS = 3_000;
const POLL_BUDGET_MS = 10 * 60 * 1000;

/**
 * Format an amount (minor units) as a compact price, e.g. "$10", "$97".
 *
 * Takes the two fields it reads rather than a `BillingPlan` so the
 * Subscriptions list can price a row from the provider snapshot on it
 * (`amount`/`currency`), which is not a plan (#109).
 */
export function formatPrice(money: { amount: number; currency: string }): string {
  const major = money.amount / 100;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: money.currency.toUpperCase(),
      maximumFractionDigits: Number.isInteger(major) ? 0 : 2,
    }).format(major);
  } catch {
    // Unknown currency code — fall back to a bare number.
    return `${major}`;
  }
}

export const perLabel = (interval: "month" | "year") =>
  interval === "month" ? "/mo" : "/yr";

/**
 * Upgrade-to-Team flow (ShareDialog modal pattern). Shows the plan card with a
 * monthly/yearly toggle built from `billingConfig.plans`, kicks off a hosted
 * checkout, then WAITS: the browser redirect is never treated as proof of
 * payment — only a `status: "active"` from polling unlocks Team. On a server
 * with `model: "team"` the checkout targets the caller's billing ACCOUNT with a
 * seat count; an older server keeps the per-vault checkout.
 *
 * `orgId` names the vault being upgraded, defaulting to the active one. The
 * Subscriptions list passes it explicitly: it can upgrade any vault the user
 * owns, including one they are not currently working in (#109).
 */
export function UpgradeDialog({
  onClose,
  orgId: orgIdProp,
  reason,
}: {
  onClose: () => void;
  orgId?: string;
  /** Why the dialog opened (a limit was hit): one muted line under the heading. */
  reason?: string;
}) {
  const billingConfig = useStore((s) => s.billingConfig);
  const activeOrgId = useStore((s) => s.session?.activeOrganizationId ?? null);
  const orgId = orgIdProp ?? activeOrgId;
  // The store's own view of this vault's plan. The checkout success page hands
  // back into the app with a deep link that refreshes both of these, so while
  // we are waiting they can turn "pro" before our next 3-second poll — and the
  // dialog should not keep a spinner up over a fact the rest of the app shows.
  const storeSaysPro = useStore((s) => {
    if (!orgId) return false;
    if (s.myBilling?.vaults.some((v) => v.orgId === orgId && v.plan === "pro")) return true;
    return orgId === activeOrgId && s.orgBilling?.status === "active";
  });

  const teamMode = billingConfig?.model === "team" && !!billingConfig.team;
  const team = billingConfig?.team;
  const currency = team?.currency ?? "usd";
  // Team servers price per seat; old servers send whole-vault `plans`. Both
  // reduce to {interval, amount, currency} for the cards below.
  const plans: { interval: "month" | "year"; amount: number; currency: string; label?: string }[] =
    teamMode
      ? (team?.prices ?? []).map((p) => ({ interval: p.interval, amount: p.perSeat, currency }))
      : (billingConfig?.plans ?? []);
  const monthly = plans.find((p) => p.interval === "month");
  const yearly = plans.find((p) => p.interval === "year");
  const minSeats = team?.minSeats ?? 3;

  const [account, setAccount] = useState<MyBillingAccount | null>(null);
  const used = account?.seats.used ?? 0;
  // No seat picker here: the checkout page lets the buyer change the count.
  // We send the default (plan minimum, or everyone already counted).
  const seats = defaultSeats(used, minSeats);
  useEffect(() => {
    if (!teamMode) return;
    let live = true;
    authManager.api
      .getBillingAccount()
      .then((a) => {
        if (!live) return;
        setAccount(a);
      })
      .catch(() => {
        /* checkout falls back to the plan minimum */
      });
    return () => {
      live = false;
    };
  }, [teamMode, minSeats]);

  const [interval, setInterval] = useState<"month" | "year">(yearly ? "year" : "month");
  const [phase, setPhase] = useState<"plan" | "waiting" | "success" | "timeout">("plan");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The checkout URL the waiting screen's "Open checkout again" reopens.
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);

  const timerRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);

  const selected = interval === "month" ? monthly : yearly;

  // Yearly savings vs paying monthly for a year — computed, never hardcoded.
  const saveLabel = teamMode
    ? yearlySavingsLabel(billingConfig)
    : monthly && yearly && monthly.amount > 0 && yearly.amount < monthly.amount * 12
      ? `Save ${Math.round((1 - yearly.amount / (monthly.amount * 12)) * 100)}%`
      : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Stop any in-flight poll when the dialog unmounts.
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  // Waiting (or timed out), and the store already knows this vault is Pro:
  // that is the success we were polling for — stop polling and show it.
  useEffect(() => {
    if (!storeSaysPro) return;
    if (phase !== "waiting" && phase !== "timeout") return;
    cancelledRef.current = true;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    setPhase("success");
  }, [storeSaysPro, phase]);

  /** One billing check: on `active`, flip to success + refresh the store. */
  const checkActive = async (): Promise<boolean> => {
    if (!teamMode && !orgId) return false;
    try {
      const status = teamMode
        ? (await authManager.api.getBillingAccount()).status
        : (await authManager.api.getOrgBilling(orgId!)).status;
      if (status === "active") {
        setPhase("success");
        await useStore.getState().refreshOrgBilling();
        // The Subscriptions list this may have been opened from is a second
        // reader of the same fact — leaving it stale would show the vault we
        // just upgraded as Free.
        await useStore.getState().refreshMyBilling();
        return true;
      }
    } catch {
      /* transient — keep polling */
    }
    return false;
  };

  const startPolling = () => {
    cancelledRef.current = false;
    const deadline = Date.now() + POLL_BUDGET_MS;
    const tick = async () => {
      if (cancelledRef.current) return;
      const done = await checkActive();
      if (done || cancelledRef.current) return;
      if (Date.now() >= deadline) {
        setPhase("timeout");
        return;
      }
      timerRef.current = window.setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };
    timerRef.current = window.setTimeout(() => void tick(), POLL_INTERVAL_MS);
  };

  const startCheckout = async () => {
    if ((!teamMode && !orgId) || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { url } = teamMode
        ? await authManager.api.teamCheckout({ seats, interval })
        : await authManager.api.createBillingCheckout(orgId!, interval);
      setCheckoutUrl(url);
      await ipc.openExternal(url);
      setPhase("waiting");
      startPolling();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Stop any poll in flight and go back to choosing a plan (the dialog stays open). */
  const backToPlans = () => {
    cancelledRef.current = true;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    setChecking(false);
    setError(null);
    setPhase("plan");
  };

  const reopenCheckout = async () => {
    if (!checkoutUrl) return;
    setError(null);
    try {
      await ipc.openExternal(checkoutUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const checkAgain = async () => {
    if (checking) return;
    // An explicit retry: no poll is running on the timeout screen, and Back
    // (which sets this) must win over a check that answers after it.
    cancelledRef.current = false;
    setChecking(true);
    const done = await checkActive();
    setChecking(false);
    // If still not active, remain on the timeout screen so they can retry.
    if (!done && !cancelledRef.current) setPhase("timeout");
  };

  // Portalled to <body> so the fixed backdrop can never be trapped inside the
  // Settings card this opens from: any transform/filter between here and <body>
  // becomes this dialog's containing block, and settings is several nested cards
  // deep. (Those cards animate opacity only for the same reason — see
  // `components/SettingsModal.tsx`.)
  return createPortal(
    // Team mode opts into the large-modal size (`.is-page` on both the
    // backdrop and the panel) for plan selection only: a big centred panel over
    // the usual dimming backdrop, above Settings (z 300 over 200), which stays
    // visible, dimmed. The waiting/timeout/success phases swap the panel to
    // `.is-compact` (vault mode's content-height size) — a class swap on the
    // same element, so nothing remounts.
    <div className={`modal-backdrop${teamMode ? " is-page" : ""}`} onClick={onClose}>
      <div
        className={`modal upgrade-dialog${
          teamMode ? (phase === "plan" ? " is-tiers is-page" : " is-tiers is-compact") : ""
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span>{teamMode ? "Upgrade" : "Upgrade to Pro"}</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-page-body">
        <div className="modal-page-content">

        {phase === "plan" && teamMode && (
          <>
            <h2 className="upgrade-tiers-heading">Plans that grow with your team</h2>
            {reason && <p className="upgrade-reason muted">{reason}</p>}
            <div className="upgrade-tiers">
              <section className="upgrade-tier" aria-label="Free plan">
                {/* Every card has the same eight rows (icon, head, tagline,
                    price, controls, action, list head, list) so the subgrid
                    lines them up; Free fills Team-only rows with placeholders. */}
                <div className="upgrade-tier-icon">
                  <TierIcon kind="free" />
                </div>
                <div className="upgrade-tier-head">
                  <span className="upgrade-tier-name">Free</span>
                </div>
                <div className="upgrade-tier-tagline">For you and one teammate</div>
                <div className="upgrade-tier-price">
                  <span className="upgrade-amount">{formatMoney(0, currency)}</span>
                  <span className="upgrade-tier-unit">
                    <span>{currency.toUpperCase()}</span>
                    <span>/ month</span>
                  </span>
                </div>
                <div className="upgrade-tier-controls upgrade-tier-muted">
                  Up to 2 people · 1 synced vault
                </div>
                <div className="upgrade-tier-action">
                  <button type="button" className="ghost-pill upgrade-tier-cta" disabled>
                    Your current plan
                  </button>
                  <div className="upgrade-tier-footnote upgrade-tier-centered" aria-hidden="true">
                    {"\u00a0"}
                  </div>
                </div>
                <div className="upgrade-tier-list-head is-placeholder" aria-hidden="true">
                  {"\u00a0"}
                </div>
                <ul className="upgrade-features">
                  {FREE_PLAN_INCLUDES.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </section>

              <section className="upgrade-tier is-featured" aria-label="Team plan">
                <div className="upgrade-tier-icon">
                  <TierIcon kind="team" />
                </div>
                <div className="upgrade-tier-head">
                  <span className="upgrade-tier-name">Team</span>
                  {monthly && yearly && (
                    <div className="segmented upgrade-tier-toggle" role="radiogroup" aria-label="Billing interval">
                      <button
                        type="button"
                        role="radio"
                        aria-checked={interval === "month"}
                        className={interval === "month" ? "active" : ""}
                        onClick={() => setInterval("month")}
                      >
                        Monthly
                      </button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={interval === "year"}
                        className={interval === "year" ? "active" : ""}
                        onClick={() => setInterval("year")}
                      >
                        Yearly
                        {saveLabel && <span className="upgrade-tier-save"> · {saveLabel}</span>}
                      </button>
                    </div>
                  )}
                </div>
                <div className="upgrade-tier-tagline">For teams of {minSeats} or more</div>
                <div className="upgrade-tier-price">
                  {selected && (
                    <>
                      <span className="upgrade-amount">{formatMoney(selected.amount, currency)}</span>
                      <span className="upgrade-tier-unit">
                        <span>{currency.toUpperCase()}</span>
                        <span>/ seat / {selected.interval === "year" ? "year" : "month"}</span>
                      </span>
                    </>
                  )}
                </div>

                {/* The seat count is picked on the checkout page, which also
                    shows the total; this row only keeps the subgrid aligned. */}
                <div className="upgrade-tier-controls upgrade-tier-muted">
                  Choose the number of seats at checkout
                </div>

                <div className="upgrade-tier-action">
                  <button
                    className="primary upgrade-tier-cta"
                    disabled={busy || !selected}
                    aria-busy={busy}
                    onClick={() => void startCheckout()}
                  >
                    {busy && <span className="btn-spinner" aria-hidden="true" />}
                    <span>
                      Get Team
                    </span>
                  </button>
                  <div className="upgrade-tier-footnote upgrade-tier-centered">
                    No commitment · Cancel anytime
                  </div>
                  {used > 0 && (
                    <div className="upgrade-tier-footnote upgrade-tier-centered">
                      Includes the {used} {used === 1 ? "person" : "people"} already in your vaults
                    </div>
                  )}
                  {error && <div className="auth-error">{error}</div>}
                </div>

                <div className="upgrade-tier-list-head">Everything in Free, and:</div>
                <ul className="upgrade-features">
                  {TEAM_BENEFITS.map((benefit) => (
                    <li key={benefit}>{benefit}</li>
                  ))}
                </ul>
              </section>
            </div>
          </>
        )}

        {phase === "plan" && !teamMode && (
          <>
            {reason && <p className="upgrade-reason muted">{reason}</p>}
            <p className="upgrade-lead">
              <strong>Pro</strong> adds unlimited members, standalone file sync and Baalda
              Assistant to this vault. Pick how you'd like to pay.
            </p>
            <p className="muted">{legacyFreePlanExplanation(billingConfig?.freeLimits)}</p>

            <div
              className="upgrade-plans"
              role="radiogroup"
              aria-label="Billing interval"
            >
              {monthly && (
                <button
                  type="button"
                  role="radio"
                  aria-checked={interval === "month"}
                  className={`upgrade-plan-card${interval === "month" ? " selected" : ""}`}
                  onClick={() => setInterval("month")}
                >
                  <span className="upgrade-plan-head">
                    <span className="upgrade-plan-cadence">Monthly</span>
                  </span>
                  <span className="upgrade-price">
                    <span className="upgrade-amount">{formatPrice(monthly)}</span>
                    <span className="upgrade-per">{perLabel("month")}</span>
                  </span>
                  <span className="upgrade-plan-note" />
                </button>
              )}
              {yearly && (
                <button
                  type="button"
                  role="radio"
                  aria-checked={interval === "year"}
                  className={`upgrade-plan-card${interval === "year" ? " selected" : ""}`}
                  onClick={() => setInterval("year")}
                >
                  <span className="upgrade-plan-head">
                    <span className="upgrade-plan-cadence">Yearly</span>
                    {saveLabel && <span className="upgrade-save-badge">{saveLabel}</span>}
                  </span>
                  <span className="upgrade-price">
                    <span className="upgrade-amount">{formatPrice(yearly)}</span>
                    <span className="upgrade-per">{perLabel("year")}</span>
                  </span>
                  <span className="upgrade-plan-note" />
                </button>
              )}
            </div>

            <ul className="upgrade-features">
              {LEGACY_PRO_BENEFITS.map((benefit) => (
                <li key={benefit}>{benefit}</li>
              ))}
            </ul>
            {error && <div className="auth-error">{error}</div>}

            <button
              className="primary upgrade-cta"
              disabled={busy || !selected || !orgId}
              aria-busy={busy}
              onClick={() => void startCheckout()}
            >
              {busy && <span className="btn-spinner" aria-hidden="true" />}
              <span>
                Upgrade
                {selected ? ` — ${formatPrice(selected)}${perLabel(selected.interval)}` : ""}
              </span>
            </button>
          </>
        )}

        {phase === "waiting" && (
          <div className="upgrade-waiting">
            <span className="btn-spinner accent" aria-hidden="true" />
            <div className="subhead">Waiting for payment…</div>
            <div className="muted">
              Complete the checkout in your browser. This unlocks automatically once
              your payment is confirmed — you can leave this open.
            </div>
            {error && <div className="auth-error">{error}</div>}
            <div className="upgrade-waiting-actions">
              {checkoutUrl && (
                <button className="primary sm" onClick={() => void reopenCheckout()}>
                  Open checkout again
                </button>
              )}
              <button className="ghost-pill sm" onClick={backToPlans}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {phase === "timeout" && (
          <div className="upgrade-waiting">
            <div className="subhead">Still waiting on payment</div>
            <div className="muted">
              We haven't seen the payment confirmed yet. If you finished checkout, it
              can take a moment — check again below.
            </div>
            {error && <div className="auth-error">{error}</div>}
            <div className="upgrade-waiting-actions">
              <button
                className="primary sm"
                disabled={checking}
                aria-busy={checking}
                onClick={() => void checkAgain()}
              >
                {checking && <span className="btn-spinner" aria-hidden="true" />}
                <span>Check again</span>
              </button>
              <button className="ghost-pill sm" onClick={backToPlans}>
                Back
              </button>
            </div>
          </div>
        )}

        {phase === "success" && (
          <div className="upgrade-waiting">
            <div className="upgrade-success-mark" aria-hidden="true">
              ✓
            </div>
            <div className="subhead">{teamMode ? "You're on Team" : "You're on Pro"}</div>
            <div className="muted">
              {teamMode
                ? "Your vaults now sync standalone files, and your seats are ready for your team."
                : "This vault now has unlimited members, standalone file sync and Baalda Assistant."}
            </div>
            <button className="primary sm" onClick={onClose}>
              Done
            </button>
          </div>
        )}
        </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * The 40px plan glyph at the top of each Upgrade card. Same paths as the app's
 * folder row icon (the member Access board) and the people icon (Vault Settings
 * → Members and access), drawn thinner at this size.
 */
function TierIcon({ kind }: { kind: "free" | "team" }) {
  return (
    <svg
      width="40"
      height="40"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === "free" ? (
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      ) : (
        <>
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
        </>
      )}
    </svg>
  );
}

/**
 * The app-wide Upgrade dialog, opened from any screen through
 * `useStore.getState().requestUpgradeDialog({ reason })` (a limit nudge, the
 * Turn-on-sync refusal). Mounted once beside `App` in `main.tsx`.
 */
export function UpgradeDialogHost() {
  const request = useStore((s) => s.upgradeDialogRequest);
  if (!request) return null;
  return (
    <UpgradeDialog
      key={request.token}
      orgId={request.orgId}
      reason={request.reason}
      onClose={() => useStore.getState().clearUpgradeDialogRequest()}
    />
  );
}
