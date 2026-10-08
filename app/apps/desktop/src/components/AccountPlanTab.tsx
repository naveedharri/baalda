import { useCallback, useEffect, useRef, useState } from "react";
import type { BillingConfig, BillingUsage, MyBillingAccount } from "../lib/api";
import { authManager } from "../lib/auth/authManager";
import {
  classifyBillingConfigResult,
  type BillingConfigState,
  billingErrorMessage,
  discountLine,
  formatBytes,
  LAPSED_COPY,
  PLAN_LOAD_ERROR_COPY,
  planPillLabel,
  planPriceLine,
  seatUsageLines,
  SELF_HOSTED_PLAN_COPY,
} from "../lib/billing";
import * as ipc from "../lib/ipc";
import { toast } from "../lib/toast";
import { useStore } from "../store";
import { AsyncButton } from "./AsyncButton";
import { ConfirmDialog } from "./ConfirmDialog";
import { ManageSeatsDialog } from "./ManageSeatsDialog";
import { SeatUsageBreakdown } from "./SeatUsageBreakdown";
import { UpgradeDialog } from "./UpgradeDialog";
import { VaultTile } from "./VaultSwitcher";

/** Compact absolute date, same shape as the vault Billing tab's. */
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function plural(n: number, singular: string, pluralNoun: string): string {
  return `${n} ${n === 1 ? singular : pluralNoun}`;
}

type Loaded = {
  state: Exclude<BillingConfigState, "error">;
  config: BillingConfig;
  account: MyBillingAccount | null;
  usage: BillingUsage | null;
};

/** How long the tab waits before its one automatic retry of a failed fetch. */
const RETRY_DELAY_MS = 2000;

/** A request's value, or null when it failed — for the self-hosted page, which
 *  shows what answers and never an error. */
async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

/**
 * Account Settings → Plan & Billing (Team model). One billing account per owner:
 * one plan card (name, pill, price line, actions; seat breakdown on Team), the
 * account's usage as tiles, and the people who count as a table. Usage is per vault and lives in Vault Settings → Usage. Old
 * servers (`model !== "team"`) bill per vault, so this tab only points at each
 * vault's own Billing tab there.
 */
export function AccountPlanTab() {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const [managingSeats, setManagingSeats] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** One attempt. Throws on anything that is not a definitive answer. */
  const fetchOnce = useCallback(async (): Promise<Loaded> => {
    let config: BillingConfig;
    let state: BillingConfigState;
    try {
      config = await authManager.api.probeBillingConfig();
      state = classifyBillingConfigResult(config);
    } catch (e) {
      state = classifyBillingConfigResult(e);
      if (state !== "disabled") throw e;
      config = { enabled: false };
    }
    if (state === "error") throw new Error("unclassifiable billing config");
    if (state === "disabled") {
      // Billing off (self-hosted without a provider): the account routes may
      // 404 too. Show whatever answers; never an error for this case.
      const [account, usage] = await Promise.all([
        orNull(authManager.api.getBillingAccount()),
        orNull(authManager.api.getBillingUsage()),
      ]);
      return { state, config, account, usage };
    }
    if (state === "vault") return { state, config, account: null, usage: null };
    const [account, usage] = await Promise.all([
      authManager.api.getBillingAccount(),
      authManager.api.getBillingUsage(),
    ]);
    return { state, config, account, usage };
  }, []);

  /** A failed fetch is never a verdict: retry once after 2 s, then show the
   *  error with Try again. */
  const load = useCallback(async () => {
    setError(null);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const loaded = await fetchOnce();
        if (mounted.current) setData(loaded);
        return;
      } catch {
        if (attempt === 0) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
    if (mounted.current) setError(PLAN_LOAD_ERROR_COPY);
  }, [fetchOnce]);

  const organizations = useStore((s) => s.organizations);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <>
        <div className="auth-error">{error}</div>
        <AsyncButton className="secondary" onClick={load}>
          Try again
        </AsyncButton>
      </>
    );
  }
  if (!data) return <div className="muted">Loading…</div>;

  const { config, account, usage } = data;
  if (data.state === "disabled") {
    return (
      <SelfHostedPlan account={account} usage={usage} fallbackVaults={organizations.length} />
    );
  }
  if (data.state === "vault" || !account) {
    return (
      <div className="muted perm-empty">
        Billing is per vault on this server; manage it in each vault's settings.
      </div>
    );
  }

  const ownsVaults = account.vaults.length > 0;
  const isTeam = account.plan === "team";
  const pill = planPillLabel({
    plan: account.plan,
    status: account.status,
    lapsed: account.lapsed,
    complimentary: !!account.complimentaryUntil,
  });
  const discount = discountLine({ ...account, currency: config.team?.currency ?? "usd" });

  // The store's billing mirror and locks feed Vault Settings and the lapse
  // padlocks; a plan change here must reach them too, not only this tab.
  const refreshShared = () => {
    const st = useStore.getState();
    void st.refreshMyBilling();
    void st.refreshOrgBilling();
    void st.refreshLocks();
  };

  const run = async (fn: () => Promise<unknown>, done: string): Promise<boolean> => {
    setActionError(null);
    try {
      await fn();
      toast(done);
      await load();
      refreshShared();
      return true;
    } catch (e) {
      const message = billingErrorMessage(e);
      setActionError(message);
      toast(message, "error");
      return false;
    }
  };

  const openPortal = async () => {
    setActionError(null);
    try {
      const { url } = await authManager.api.accountPortalUrl();
      await ipc.openExternal(url);
    } catch (e) {
      setActionError(billingErrorMessage(e));
    }
  };

  // ---- Header line under the plan name ----
  const seatsBought = account.seats.purchased;
  const summary = isTeam
    ? [
        planPriceLine(account.plan, account.interval, config.team),
        seatsBought != null ? plural(seatsBought, "seat", "seats") : null,
        account.currentPeriodEnd
          ? `${account.cancelAtPeriodEnd ? "cancels on" : "renews"} ${formatDate(account.currentPeriodEnd)}`
          : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "For you and one teammate · $0";

  // ---- Usage tiles: meters against the Free ceilings, plain counts on Team ----
  const syncedVaults = usage ? (usage.totals.vaults ?? usage.vaults.length) : 0;
  const vaultLimit = isTeam ? null : (usage?.limits.vaults ?? account.limits.vaults);
  const peopleLimit = isTeam ? null : (usage?.limits.people ?? account.limits.people);
  const freeBase = config.free?.syncedVaults ?? null;
  const [bytesValue, bytesUnit] = formatBytes(usage?.totals.storageBytes ?? 0).split(" ");
  const tiles: {
    key: string;
    caption: string;
    value: string;
    sub: string;
    meter: { used: number; limit: number } | null;
  }[] = usage
    ? [
        {
          key: "vaults",
          caption: "Synced vaults",
          value: String(syncedVaults),
          sub:
            vaultLimit != null
              ? freeBase != null && vaultLimit > freeBase
                ? `of ${vaultLimit} · includes vaults you had before`
                : `of ${vaultLimit}`
              : syncedVaults === 1 ? "vault" : "vaults",
          meter: vaultLimit != null ? { used: syncedVaults, limit: vaultLimit } : null,
        },
        {
          key: "people",
          caption: "People",
          value: String(usage.totals.people),
          sub:
            peopleLimit != null
              ? `of ${peopleLimit} on this account`
              : usage.totals.people === 1 ? "person" : "people",
          meter: peopleLimit != null ? { used: usage.totals.people, limit: peopleLimit } : null,
        },
        {
          key: "notes",
          caption: "Notes",
          value: String(usage.totals.notes),
          sub: "across your vaults",
          meter: null,
        },
        {
          key: "attachments",
          caption: "Attachments",
          value: bytesValue ?? "0",
          sub: bytesUnit ?? "B",
          meter: null,
        },
      ]
    : [];

  return (
    <>
      {/* ---- Plan: one card, summary left, actions right ---- */}
      <div className={`billing-card${isTeam ? " plan-pro" : ""}`}>
        <div className="plan-page-head">
          <div className="plan-page-summary">
            <div className="billing-plan-head">
              <span className="billing-plan-name">{isTeam ? "Team" : "Free"}</span>
              <span className={`billing-status ${account.lapsed ? "canceled" : account.status}`}>
                {pill}
              </span>
            </div>
            <div className="billing-section-note">{summary}</div>
            {discount && <div className="billing-section-note muted">{discount}</div>}
            {account.complimentaryUntil && (
              <div className="billing-section-note">
                Complimentary Team until {formatDate(account.complimentaryUntil)}
              </div>
            )}
          </div>
          {account.canManage && (
            <div className="plan-page-actions">
              {!isTeam ? (
                <button className="primary billing-action" onClick={() => setUpgrading(true)}>
                  Upgrade to Team
                </button>
              ) : (
                <>
                  <button className="primary billing-action" onClick={() => setManagingSeats(true)}>
                    Add or change seats
                  </button>
                  <div className="plan-page-links">
                    {account.cancelAtPeriodEnd || account.lapsed ? (
                      <AsyncButton
                        className="link-btn"
                        onClick={() => run(() => authManager.api.accountResume(), "Plan resumed.")}
                      >
                        Resume plan
                      </AsyncButton>
                    ) : (
                      <AsyncButton
                        type="button"
                        className="link-btn"
                        onClick={() => {
                          setActionError(null);
                          setConfirmCancel(true);
                        }}
                      >
                        Cancel plan
                      </AsyncButton>
                    )}
                    <AsyncButton className="link-btn" onClick={openPortal}>
                      Manage billing
                    </AsyncButton>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {isTeam &&
          (account.seats.purchased != null ? (
            <SeatUsageBreakdown
              seats={account.seats}
              canManage={account.canManage}
              showManage={false}
              formatDate={formatDate}
              onManage={() => setManagingSeats(true)}
              onKeepSeats={() =>
                run(
                  () => authManager.api.setSeats(account.seats.purchased ?? 0),
                  "Seat change cancelled.",
                )
              }
            />
          ) : (
            seatUsageLines(account.seats, formatDate).map((line) => (
              <div key={line} className="billing-section-note">
                {line}
              </div>
            ))
          ))}
        {account.lapsed && <div className="auth-error">{LAPSED_COPY}</div>}
        {!account.canManage && (
          <div className="billing-section-note">
            {ownsVaults
              ? "Billing is handled by the vault owner."
              : "You don't own any vaults; billing is handled by each vault's owner."}
          </div>
        )}
      </div>
      {actionError && !confirmCancel && <div className="auth-error">{actionError}</div>}

      {/* ---- Usage on this account ---- */}
      {ownsVaults && tiles.length > 0 && (
        <>
          <div className="subhead">Usage on this account</div>
          <div className="vault-usage-tiles">
            {tiles.map((t) => {
              const full = !!t.meter && t.meter.limit > 0 && t.meter.used >= t.meter.limit;
              const pct =
                t.meter && t.meter.limit > 0
                  ? Math.min(100, Math.round((t.meter.used / t.meter.limit) * 100))
                  : 0;
              return (
                <div key={t.key} className="vault-usage-tile">
                  <span className="vault-usage-caption">{t.caption}</span>
                  <span className="vault-usage-value">{t.value}</span>
                  <span className="vault-usage-sub" title={t.sub}>
                    {t.sub}
                  </span>
                  {t.meter && (
                    <div
                      className={`vault-usage-meter${full ? " is-full" : ""}`}
                      role="meter"
                      aria-label={t.caption}
                      aria-valuemin={0}
                      aria-valuemax={t.meter.limit}
                      aria-valuenow={t.meter.used}
                    >
                      <span style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* ---- People who count (owners only) ---- */}
      {account.canManage && account.people.length > 0 && (
        <>
          <div className="subhead">People who count</div>
          <table className="members-table plan-page-people">
            <thead>
              <tr>
                <th>Person</th>
                <th>Vaults</th>
                {isTeam && <th className="plan-page-seat-col">Seat</th>}
              </tr>
            </thead>
            <tbody>
              {account.people.map((p) => {
                return (
                  <tr key={p.userId}>
                    <td>
                      <div className="members-table-names">
                        <span className="members-table-name">{p.name || p.email}</span>
                        {p.name && <span className="muted">{p.email}</span>}
                      </div>
                    </td>
                    <td>
                      <div className="plan-page-vault-chips">
                        {p.vaults.map((id) => {
                          const name = account.vaults.find((v) => v.orgId === id)?.name ?? id;
                          return (
                            <span key={id} className="plan-page-vault-chip">
                              <VaultTile identity={`org:${id}`} name={name} />
                              <span>{name}</span>
                            </span>
                          );
                        })}
                      </div>
                    </td>
                    {isTeam && <td className="muted plan-page-seat-col">1 seat</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}

      {upgrading && (
        <UpgradeDialog
          onClose={() => {
            setUpgrading(false);
            void load();
          }}
        />
      )}
      {managingSeats && (
        <ManageSeatsDialog
          account={account}
          config={config}
          formatDate={formatDate}
          onClose={() => setManagingSeats(false)}
          onChanged={() => {
            void load();
            refreshShared();
          }}
          onResume={() => run(() => authManager.api.accountResume(), "Plan resumed.")}
        />
      )}
      {confirmCancel && (
        <ConfirmDialog
          title="Cancel the Team plan?"
          confirmLabel="Cancel plan"
          cancelLabel="Keep it"
          onCancel={() => setConfirmCancel(false)}
          onConfirm={async () => {
            const ok = await run(
              () => authManager.api.accountCancel(),
              "Plan will cancel at the end of the period.",
            );
            if (ok) setConfirmCancel(false);
          }}
        >
          <p>
            {account.currentPeriodEnd
              ? `Team stays on until ${formatDate(account.currentPeriodEnd)}. After that, sync becomes read-only for vaults with more than 2 people until you resume.`
              : "Team stays on until the end of the current period. After that, sync becomes read-only for vaults with more than 2 people until you resume."}
          </p>
          {actionError && <div className="auth-error">{actionError}</div>}
        </ConfirmDialog>
      )}
    </>
  );
}

/**
 * Plan & Billing on a server with billing off (self-hosted without a provider):
 * no plan to buy, so no Upgrade. Usage and people come from the account routes
 * when they answer; otherwise the vault count falls back to the account's
 * vault list and sections without data are left out.
 */
function SelfHostedPlan({
  account,
  usage,
  fallbackVaults,
}: {
  account: MyBillingAccount | null;
  usage: BillingUsage | null;
  fallbackVaults: number;
}) {
  const vaults = usage ? (usage.totals.vaults ?? usage.vaults.length) : fallbackVaults;
  const tiles: { key: string; caption: string; value: string; sub: string }[] = [
    { key: "vaults", caption: "Synced vaults", value: String(vaults), sub: vaults === 1 ? "vault" : "vaults" },
  ];
  if (usage) {
    const [bytesValue, bytesUnit] = formatBytes(usage.totals.storageBytes ?? 0).split(" ");
    tiles.push(
      {
        key: "people",
        caption: "People",
        value: String(usage.totals.people),
        sub: usage.totals.people === 1 ? "person" : "people",
      },
      { key: "notes", caption: "Notes", value: String(usage.totals.notes), sub: "across your vaults" },
      { key: "attachments", caption: "Attachments", value: bytesValue ?? "0", sub: bytesUnit ?? "B" },
    );
  }
  const people = account?.canManage ? account.people : [];
  return (
    <>
      <div className="billing-card">
        <div className="plan-page-head">
          <div className="plan-page-summary">
            <div className="billing-plan-head">
              <span className="billing-plan-name">Self-hosted</span>
              <span className="billing-status none">No limits</span>
            </div>
            <div className="billing-section-note">{SELF_HOSTED_PLAN_COPY}</div>
          </div>
        </div>
      </div>

      {(usage || vaults > 0) && (
        <>
          <div className="subhead">Usage on this account</div>
          <div className="vault-usage-tiles">
            {tiles.map((t) => (
              <div key={t.key} className="vault-usage-tile">
                <span className="vault-usage-caption">{t.caption}</span>
                <span className="vault-usage-value">{t.value}</span>
                <span className="vault-usage-sub" title={t.sub}>
                  {t.sub}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {account && people.length > 0 && (
        <>
          <div className="subhead">People who count</div>
          <table className="members-table plan-page-people">
            <thead>
              <tr>
                <th>Person</th>
                <th>Vaults</th>
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.userId}>
                  <td>
                    <div className="members-table-names">
                      <span className="members-table-name">{p.name || p.email}</span>
                      {p.name && <span className="muted">{p.email}</span>}
                    </div>
                  </td>
                  <td>
                    <div className="plan-page-vault-chips">
                      {p.vaults.map((id) => {
                        const name = account.vaults.find((v) => v.orgId === id)?.name ?? id;
                        return (
                          <span key={id} className="plan-page-vault-chip">
                            <VaultTile identity={`org:${id}`} name={name} />
                            <span>{name}</span>
                          </span>
                        );
                      })}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
