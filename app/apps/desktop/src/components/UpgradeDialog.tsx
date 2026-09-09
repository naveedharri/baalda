import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { authManager } from "../lib/auth/authManager";
import * as ipc from "../lib/ipc";
import { useStore } from "../store";

/** Poll cadence + budget while waiting for the checkout webhook to land. */
const POLL_INTERVAL_MS = 3_000;
const POLL_BUDGET_MS = 3 * 60 * 1000;

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
 * Upgrade-to-Pro flow (ShareDialog modal pattern). Shows the plan card with a
 * monthly/yearly toggle built from `billingConfig.plans`, kicks off a hosted
 * checkout, then WAITS: the browser redirect is never treated as proof of
 * payment — only a `status: "active"` from polling `getOrgBilling` unlocks Pro.
 *
 * `orgId` names the vault being upgraded, defaulting to the active one. The
 * Subscriptions list passes it explicitly: it can upgrade any vault the user
 * owns, including one they are not currently working in (#109).
 */
export function UpgradeDialog({
  onClose,
  orgId: orgIdProp,
}: {
  onClose: () => void;
  orgId?: string;
}) {
  const billingConfig = useStore((s) => s.billingConfig);
  const activeOrgId = useStore((s) => s.session?.activeOrganizationId ?? null);
  const orgId = orgIdProp ?? activeOrgId;

  const plans = billingConfig?.plans ?? [];
  const monthly = plans.find((p) => p.interval === "month");
  const yearly = plans.find((p) => p.interval === "year");

  const [interval, setInterval] = useState<"month" | "year">(yearly ? "year" : "month");
  const [phase, setPhase] = useState<"plan" | "waiting" | "success" | "timeout">("plan");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const timerRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);

  const selected = interval === "month" ? monthly : yearly;

  // Yearly savings vs paying monthly for a year — computed, never hardcoded.
  const savePct =
    monthly && yearly && monthly.amount > 0
      ? Math.round((1 - yearly.amount / (monthly.amount * 12)) * 100)
      : 0;

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

  /** One billing check: on `active`, flip to success + refresh the store. */
  const checkActive = async (): Promise<boolean> => {
    if (!orgId) return false;
    try {
      const b = await authManager.api.getOrgBilling(orgId);
      if (b.status === "active") {
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
    if (!orgId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { url } = await authManager.api.createBillingCheckout(orgId, interval);
      await ipc.openExternal(url);
      setPhase("waiting");
      startPolling();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const checkAgain = async () => {
    if (checking) return;
    setChecking(true);
    const done = await checkActive();
    setChecking(false);
    // If still not active, remain on the timeout screen so they can retry.
    if (!done) setPhase("timeout");
  };

  // Portalled to <body> so the fixed backdrop can never be trapped inside the
  // Settings card this opens from: any transform/filter between here and <body>
  // becomes this dialog's containing block, and settings is several nested cards
  // deep. (Those cards animate opacity only for the same reason — see
  // `components/SettingsModal.tsx`.)
  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal upgrade-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>Upgrade to Pro</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {phase === "plan" && (
          <>
            <p className="upgrade-lead">
              Unlock unlimited collaboration for the{" "}
              <strong>{selected?.label ?? "Pro"}</strong> plan — pick how you'd like
              to pay.
            </p>

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
                  <span className="upgrade-plan-note">per vault</span>
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
                    {savePct > 0 && (
                      <span className="upgrade-save-badge">Save {savePct}%</span>
                    )}
                  </span>
                  <span className="upgrade-price">
                    <span className="upgrade-amount">{formatPrice(yearly)}</span>
                    <span className="upgrade-per">{perLabel("year")}</span>
                  </span>
                  <span className="upgrade-plan-note">per vault</span>
                </button>
              )}
            </div>

            <ul className="upgrade-features">
              <li>Unlimited team members</li>
              <li>Unlimited notes, devices &amp; AI edits</li>
              <li>Doesn't count toward your free vaults</li>
              <li>Priority support</li>
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
                Upgrade{selected ? ` — ${formatPrice(selected)}${perLabel(selected.interval)}` : ""}
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
            <button
              className="primary sm"
              disabled={checking}
              aria-busy={checking}
              onClick={() => void checkAgain()}
            >
              {checking && <span className="btn-spinner" aria-hidden="true" />}
              <span>Check again</span>
            </button>
          </div>
        )}

        {phase === "success" && (
          <div className="upgrade-waiting">
            <div className="upgrade-success-mark" aria-hidden="true">
              ✓
            </div>
            <div className="subhead">You're on Pro</div>
            <div className="muted">
              This vault is now unlimited — invite your whole team.
            </div>
            <button className="primary sm" onClick={onClose}>
              Done
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
