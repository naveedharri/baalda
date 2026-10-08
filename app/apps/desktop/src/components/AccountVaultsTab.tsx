/* Account Settings → Vaults. Vaults belong to the account (owner decision
   2026-10-07), so the one list of them lives here rather than in Vault
   Settings: the synced vaults this account is a member of, the local folders
   this app profile has opened, and where new vault folders go. Moved verbatim
   from the old Vault Settings → Vaults tab; the people/notes counts come from
   the account's billing usage when the server bills per seat. Rows carry no
   plan pill (the plan is the account's, said in Plan & Billing); only a
   lapsed account's vaults get a "Read-only" pill, since that changes the row. */
import { useEffect, useState } from "react";
import { ApiError, type BillingUsage, type MyBillingAccount, type OrgBilling } from "../lib/api";
import { toast } from "../lib/toast";
import { authManager } from "../lib/auth/authManager";
import { classifyLimitError, type LimitKind, limitFromError } from "../lib/billing";
import * as ipc from "../lib/ipc";
import { readOrgVaults, useStore } from "../store";
import { AsyncButton } from "./AsyncButton";
import { InvitationRows, useFreshInvitations } from "./InvitationRows";
import { ConfirmDialog } from "./ConfirmDialog";
import { VaultFolderMissingRowActions } from "./VaultFolderMissing";
import { useResetLocalCopy } from "./useResetLocalCopy";
import { RowActionsMenu } from "./RowActionsMenu";
import { LimitNudge } from "./LimitNudge";
import { UpgradeDialog } from "./UpgradeDialog";
import { useLocalFolderClasses, useLocalVaults } from "./useVaultLists";
import { hiddenForeignFootnote, visibleFolders } from "../lib/vault/vaultList";
import { formatDate, UnsyncConfirmDialog } from "./VaultSettingsDialog";

const CURRENT_LINK_TIP =
  'The active vault is also linked at "current", so tools like Claude Desktop can point at one fixed path.';

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Vaults: switch between vaults, create/join, and manage where their
 * local folders live. Each vault owns one folder under the managed root;
 * switching swaps the sidebar to that vault's folder and repoints the
 * stable `current` symlink external tools point at.
 */
export function AccountVaultsTab() {
  const session = useStore((s) => s.session);
  // Pending invitations get their own section above the synced list, with the
  // account menu's rows; showing them here marks them seen, like the menu.
  const userInvitations = useStore((s) => s.userInvitations);
  const freshInviteIds = useFreshInvitations(userInvitations);
  const reset = useResetLocalCopy();
  const organizations = useStore((s) => s.organizations);
  const members = useStore((s) => s.members);
  const vault = useStore((s) => s.vault);
  const syncEnabled = useStore((s) => s.syncEnabled);
  // The open vault's folder is gone (#228): its row says so instead of
  // "Current" and offers the banner's recovery actions.
  const rootMissing = useStore((s) => s.structureNotice.rootMissing);
  const billingEnabled = useStore((s) => s.billingConfig?.enabled === true);
  const teamBilling = useStore((s) => s.billingConfig?.model === "team");
  // Bumped after a local remove/delete so the recents list re-fetches.
  const [localsNonce, setLocalsNonce] = useState(0);
  const locals = useLocalVaults(localsNonce);
  const { classes: folderClasses, resolved: foldersResolved } = useLocalFolderClasses(
    locals,
    session ? organizations.map((o) => o.id) : [],
  );

  const [root, setRoot] = useState<string | null>(null);
  const [bound, setBound] = useState<Record<string, string>>(() => readOrgVaults());
  const [creating, setCreating] = useState(false);
  const [orgName, setOrgName] = useState("");
  const [joining, setJoining] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // orgId whose permanent deletion is awaiting a second confirming click.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // A vault that is actually PAYING, whose deletion needs the full dialog
  // instead: the two-click row has nowhere to say what happens to the money
  // (#111). Its billing snapshot rides along so the copy can name the date.
  const [subDelete, setSubDelete] = useState<
    { orgId: string; name: string; billing: OrgBilling } | null
  >(null);
  // local-vault path whose file deletion is awaiting a second confirming click.
  const [confirmDeleteLocal, setConfirmDeleteLocal] = useState<string | null>(null);
  // A vault the user is about to leave (#121). Always the full dialog: it has
  // to say that the folder on this device goes too, which a row can't.
  const [confirmLeave, setConfirmLeave] = useState<{ orgId: string; name: string } | null>(
    null,
  );
  // A vault the user is about to make LOCAL ONLY. Always the full dialog: the
  // counts, the teammates who lose access and the type-the-name gate have
  // nowhere to live in a two-click row.
  const [confirmUnsync, setConfirmUnsync] = useState<{ orgId: string; name: string } | null>(
    null,
  );
  const [actionError, setActionError] = useState<string | null>(null);
  // Free-plan vault-cap hit while creating — shows an upgrade nudge instead.
  const [limitNudge, setLimitNudge] = useState<{ kind: LimitKind; limit: number | null } | null>(
    null,
  );
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  // Team-model billing: the read-only pill and per-vault counts. Loaded once; a
  // failure (or billing off) just renders the rows without them.
  const billingConfig = useStore((s) => s.billingConfig);
  const [billing, setBilling] = useState<
    { account: MyBillingAccount; usage: BillingUsage } | null
  >(null);
  useEffect(() => {
    if (!session || !billingConfig?.enabled || billingConfig.model !== "team") {
      setBilling(null);
      return;
    }
    let live = true;
    Promise.all([authManager.api.getBillingAccount(), authManager.api.getBillingUsage()])
      .then(([account, usage]) => { if (live) setBilling({ account, usage }); })
      .catch(() => { if (live) setBilling(null); });
    return () => { live = false; };
  }, [session, billingConfig?.enabled, billingConfig?.model]);
  const usageFor = (orgId: string) =>
    billing?.usage.vaults.find((v) => v.orgId === orgId) ?? null;
  // The account's plan applies to every row, so it is not repeated per row;
  // only a lapsed account (sync read-only for its vaults) earns a pill.
  const accountLapsed = !!billing?.account.lapsed;
  const freeVaultLimit =
    billing && billing.account.plan === "free"
      ? (billing.usage.limits.vaults ?? billing.account.limits.vaults)
      : null;
  const baseFreeVaults = billingConfig?.free?.syncedVaults ?? null;

  useEffect(() => {
    let cancelled = false;
    ipc
      .getVaultsRoot()
      .then((r) => {
        if (!cancelled) setRoot(r);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const activeOrgId = session?.activeOrganizationId ?? null;
  // We only know the caller's role for the ACTIVE vault (members are loaded
  // for it alone). On the active row we can therefore hide Delete from
  // non-owners; on other rows we can't tell, so we show it and let the server
  // enforce owner-only (403, surfaced via actionError). `deleteRemoteVault` takes
  // an explicit org id, so deleting a non-active vault works without first
  // switching to it.
  const isActiveOwner =
    members.find((m) => m.userId === session?.user.id)?.role === "owner";
  const canDelete = (orgId: string) =>
    orgId === activeOrgId ? isActiveOwner : true;
  // Same uncertainty, mirrored: on the active row Leave is for non-owners
  // only; elsewhere both are offered and the server's 409 settles it.
  const canLeave = (orgId: string) =>
    orgId === activeOrgId ? !isActiveOwner : true;

  const folderName = (orgId: string): string | null => {
    const p = bound[orgId];
    return p ? (p.split("/").pop() ?? p) : null;
  };

  // The org whose folder is actually open now — the true "Current", vs. merely
  // the account's active org (you can be viewing a local folder with sync off).
  const openPath = vault?.path ?? null;
  const isOpenOrg = (orgId: string) => openPath != null && bound[orgId] === openPath;

  const switchTo = async (orgId: string) => {
    if (busy || isOpenOrg(orgId)) return;
    setBusy(true);
    try {
      await useStore.getState().setActiveOrganization(orgId);
      setBound(readOrgVaults());
    } finally {
      setBusy(false);
    }
  };

  const switchToLocal = async (path: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await useStore.getState().openLocalVault(path);
      setBound(readOrgVaults());
    } finally {
      setBusy(false);
    }
  };

  // Detach a vault from this device only (server data untouched).
  const removeLocal = async (orgId: string) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await useStore.getState().removeVaultLocally(orgId);
      setBound(readOrgVaults());
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Ask before deleting. A vault that is actually paying gets the full
   * ConfirmDialog, because "Delete everything?" cannot say the one thing its
   * owner needs to know: the subscription stops at the END of the current
   * period, and until then it can be moved to another vault (#111). Every
   * other vault keeps today's two-click row.
   *
   * A billing lookup that fails is treated as free — an unreachable billing
   * endpoint must not block a delete the user is entitled to make.
   */
  const askDelete = async (orgId: string, name: string) => {
    setActionError(null);
    // Team model: the subscription is the owner's account, and deleting a
    // vault does not touch it, so there is no subscription to warn about.
    if (!billingEnabled || teamBilling) {
      setConfirmDelete(orgId);
      return;
    }
    let billing: OrgBilling | null = null;
    try {
      billing = await authManager.api.getOrgBilling(orgId);
    } catch {
      billing = null;
    }
    if (billing && (billing.status === "active" || billing.status === "past_due")) {
      setSubDelete({ orgId, name, billing });
    } else {
      setConfirmDelete(orgId);
    }
  };

  // Permanently delete a vault everywhere (owner only, confirmed above).
  const deletePermanently = async (orgId: string) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const result = await useStore.getState().deleteRemoteVault(orgId);
      setBound(readOrgVaults());
      setConfirmDelete(null);
      setSubDelete(null);
      if (result.subscription && !teamBilling) {
        // Neutral, not success: the vault is gone, but the user is still paying
        // for the rest of the period and that time is recoverable.
        const ends = result.subscription.currentPeriodEnd;
        toast(
          ends
            ? `Vault deleted. Pro ends on ${formatDate(ends)} — move it from Billing if you want to keep it.`
            : "Vault deleted. Pro ends when the current period does — move it from Billing if you want to keep it.",
          "neutral",
        );
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Covers the 502 `subscription_cancel_failed` case: the server's message
      // rides `ApiError.message`, and NOTHING was deleted. The dialog stays
      // open (only success clears it) so the error has somewhere to show.
      setActionError(message);
      // Destructive path: a failure here must never look like a success (#85).
      // The cancel-failed message is already a full sentence (#300).
      const cancelFailed =
        e instanceof ApiError && (e.body as { error?: unknown } | undefined)?.error === "subscription_cancel_failed";
      toast(cancelFailed ? message : `Couldn't delete the vault — ${message}`, "error");
    } finally {
      setBusy(false);
    }
  };

  // Leave a vault someone else owns (confirmed above). Server first, then the
  // vault leaves this device entirely; the dialog stays open on failure so the
  // server's reason (an owner's 409, offline) has somewhere to show.
  const leaveVault = async (orgId: string, name: string) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await useStore.getState().leaveVault(orgId);
      setBound(readOrgVaults());
      setConfirmLeave(null);
      toast(`You left ${name}.`, "neutral");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setActionError(message);
      toast(`Couldn't leave the vault — ${message}`, "error");
    } finally {
      setBusy(false);
    }
  };

  // Forget a local vault from this device's list (files on disk are kept).
  const removeLocalVaultRow = async (path: string) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await useStore.getState().removeLocalVault(path);
      setLocalsNonce((n) => n + 1);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Move a local vault's folder to the OS trash (destructive, two-click confirm).
  const deleteLocalFiles = async (path: string) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await useStore.getState().deleteLocalVault(path);
      setConfirmDeleteLocal(null);
      setLocalsNonce((n) => n + 1);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const createOrg = async () => {
    if (!orgName.trim()) return;
    setBusy(true);
    setActionError(null);
    setLimitNudge(null);
    try {
      await useStore.getState().createOrganization(orgName.trim());
      setOrgName("");
      setCreating(false);
      setBound(readOrgVaults());
    } catch (e) {
      // A 402 vault-cap rejection becomes an upgrade nudge; anything else is
      // a real error (previously swallowed silently — that was the create bug).
      const kind = classifyLimitError(e);
      if (kind) setLimitNudge({ kind, limit: limitFromError(e) });
      else setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const joinByCode = async () => {
    if (!joinCode.trim()) return;
    setBusy(true);
    setJoinError(null);
    try {
      await useStore.getState().joinVault(joinCode);
      setJoinCode("");
      setJoining(false);
      setBound(readOrgVaults());
    } catch (e) {
      setJoinError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const openExisting = async () => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      // Pick only. `openLocalVault` retires the current sync scope before Rust
      // swaps its one global vault slot; `pickVault` opens during the dialog and
      // cannot provide that ordering guarantee.
      const path = await ipc.pickFolder();
      if (path) await useStore.getState().openLocalVault(path);
      setBound(readOrgVaults());
      setLocalsNonce((n) => n + 1);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Restore here / Locate folder… for the open vault whose folder is missing —
  // the same store actions as the banner and the Set-up prompt.
  const recover = (fn: () => Promise<void>) => async () => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      setBound(readOrgVaults());
      setLocalsNonce((n) => n + 1);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const changeRoot = async () => {
    try {
      const picked = await ipc.pickVaultsRoot();
      if (picked) setRoot(picked);
    } catch {
      /* picker cancelled/unavailable */
    }
  };

  // Active vault pinned to the top.
  const ordered = [
    ...organizations.filter((o) => o.id === activeOrgId),
    ...organizations.filter((o) => o.id !== activeOrgId),
  ];

  // Owner rule 2026-10-07: this list shows only folders never synced to
  // Baalda (`visibleFolders`). A folder stamped for a vault this account is a
  // member of is that vault's synced row already; one stamped for any other
  // vault is hidden (signed out: every stamped folder). Nothing renders until
  // EVERY folder's stamp has settled, so other accounts' vaults never flash.
  const localsShown = foldersResolved ? visibleFolders(locals, folderClasses) : [];
  // Counted only when signed in: signed out there is no "other" account.
  const hiddenForeign =
    session && foldersResolved
      ? locals.filter((r) => folderClasses.get(r.path) === "foreign").length
      : 0;
  const foreignFootnote = hiddenForeignFootnote(hiddenForeign);
  const localsOrdered = [
    ...localsShown.filter((r) => !syncEnabled && vault?.path === r.path),
    ...localsShown.filter((r) => !(!syncEnabled && vault?.path === r.path)),
  ];

  return (
    <>
      {session && userInvitations.length > 0 && (
        <>
          <div className="subhead">Invitations ({userInvitations.length})</div>
          <div className="account-vaults-invites">
            <InvitationRows invitations={userInvitations} freshIds={freshInviteIds} />
          </div>
          <div className="menu-sep" />
        </>
      )}
      {session && (
        <>
      <div className="subhead account-vaults-head">
        <span>Synced vaults ({organizations.length})</span>
        {!creating && !joining && (
          <span className="account-vaults-head-actions">
            <button
              type="button"
              className="ghost-pill sm vault-tab-add"
              onClick={() => setCreating(true)}
            >
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
              <span>New vault</span>
            </button>
            <button
              type="button"
              className="ghost-pill sm vault-tab-add"
              onClick={() => setJoining(true)}
            >
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" />
              </svg>
              <span>Join with code</span>
            </button>
          </span>
        )}
      </div>
      <ul className="member-list vault-list">
        {ordered.map((o) => {
          const isActive = isOpenOrg(o.id);
          const fname = folderName(o.id);
          // "Hello 4 · Hello 4" said nothing twice: the folder is named only
          // when it differs from the vault.
          const folderSuffix = !fname
            ? "· folder created on first open"
            : fname.toLowerCase() !== o.name.toLowerCase()
              ? `· ${fname}`
              : null;
          return (
            <li key={o.id}>
              <span className="menu-swatch" aria-hidden="true">
                {o.name[0]?.toUpperCase() ?? "?"}
              </span>
              <span className="member-name">
                {o.name}
                {folderSuffix && (
                  <span className="muted vault-folder">
                    {" "}
                    {folderSuffix}
                  </span>
                )}
                {usageFor(o.id) && (
                  <span className="muted vault-folder">
                    {" · "}
                    {plural(usageFor(o.id)!.people, "person", "people")}
                    {" · "}
                    {plural(usageFor(o.id)!.notes, "note", "notes")}
                  </span>
                )}
              </span>
              {usageFor(o.id) && accountLapsed && (
                <span className="billing-status canceled">Read-only</span>
              )}
              {confirmDelete === o.id ? (
                <span className="vault-row-actions">
                  <span className="muted">Delete everything?</span>
                  <button
                    className="link-btn"
                    disabled={busy}
                    onClick={() => setConfirmDelete(null)}
                  >
                    Cancel
                  </button>
                  <AsyncButton
                    className="link-btn danger"
                    disabled={busy}
                    onClick={() => deletePermanently(o.id)}
                  >
                    Delete
                  </AsyncButton>
                </span>
              ) : (
                <span className="vault-row-actions">
                  {isActive && rootMissing ? (
                    <VaultFolderMissingRowActions
                      synced={syncEnabled}
                      busy={busy}
                      onRestore={recover(() => useStore.getState().restoreVaultFolder())}
                      onLocate={recover(() => useStore.getState().locateVaultFolder())}
                    />
                  ) : isActive ? (
                    <span className="member-role">Current</span>
                  ) : (
                    <AsyncButton
                      className="link-btn"
                      disabled={busy}
                      onClick={() => switchTo(o.id)}
                    >
                      Switch
                    </AsyncButton>
                  )}
                  <RowActionsMenu
                    ariaLabel={`More actions for ${o.name}`}
                    disabled={busy}
                    actions={[
                      {
                        key: "remove",
                        label: "Remove from device",
                        title: "Stop syncing this vault here; server data is kept",
                        onSelect: () => removeLocal(o.id),
                      },
                      // Only the open synced vault, and only while its folder is
                      // there (a missing one has Restore here beside the menu).
                      ...(isActive && reset.available
                        ? [{
                            key: "reset",
                            label: "Reset local copy",
                            title: "Delete this device's copy of the vault and download a fresh one",
                            onSelect: reset.start,
                          }]
                        : []),
                      ...(canLeave(o.id)
                        ? [{
                            key: "leave",
                            label: "Leave vault",
                            danger: true,
                            separated: true,
                            title: "Leave this vault — you lose access and it is removed from this device",
                            onSelect: () => {
                              setActionError(null);
                              setConfirmLeave({ orgId: o.id, name: o.name });
                            },
                          }]
                        : []),
                      // Same owner heuristic as Delete: on the active row we know
                      // the caller's role, elsewhere we don't, so we offer it and
                      // let the server's 403 `owner_only` settle it.
                      ...(canDelete(o.id)
                        ? [
                            {
                              key: "unsync",
                              label: "Make local only",
                              danger: true,
                              separated: !canLeave(o.id),
                              title: "Delete this vault from the server and keep its files on this device",
                              onSelect: () => {
                                setActionError(null);
                                setConfirmUnsync({ orgId: o.id, name: o.name });
                              },
                            },
                            {
                              key: "delete",
                              label: "Delete vault",
                              danger: true,
                              title: "Permanently delete this vault and all its notes for everyone",
                              onSelect: () => askDelete(o.id, o.name),
                            },
                          ]
                        : []),
                    ]}
                  />
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {freeVaultLimit != null && (
        <p className="muted">
          Free includes {plural(freeVaultLimit, "synced vault", "synced vaults")} on this account
          {baseFreeVaults != null && freeVaultLimit > baseFreeVaults
            ? " (includes vaults you had before)"
            : ""}
          .
        </p>
      )}
      {reset.dialog}

      {(creating || joining) && (
        <div className="vault-tab-actions">
          {creating ? (
            <form
              className="vault-tab-form"
              onSubmit={(e) => {
                e.preventDefault();
                void createOrg();
              }}
            >
              <input
                autoFocus
                placeholder="Vault name"
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setCreating(false);
                }}
              />
              <button
                type="submit"
                className="primary"
                disabled={busy || !orgName.trim()}
              >
                Create
              </button>
              <button
                type="button"
                className="ghost-pill"
                disabled={busy}
                onClick={() => setCreating(false)}
              >
                Cancel
              </button>
            </form>
          ) : joining ? (
            <form
              className="vault-tab-form"
              onSubmit={(e) => {
                e.preventDefault();
                void joinByCode();
              }}
            >
              <input
                autoFocus
                className="vault-tab-code"
                placeholder="Join code, e.g. K7MPX2RA"
                value={joinCode}
                spellCheck={false}
                autoCapitalize="characters"
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setJoining(false);
                }}
              />
              <button
                type="submit"
                className="primary"
                disabled={busy || !joinCode.trim()}
              >
                Join
              </button>
              <button
                type="button"
                className="ghost-pill"
                disabled={busy}
                onClick={() => setJoining(false)}
              >
                Cancel
              </button>
            </form>
          ) : null}
        </div>
      )}
      {joinError && <div className="auth-error">{joinError}</div>}
      {actionError && <div className="auth-error">{actionError}</div>}
      {limitNudge && (
        <LimitNudge
          kind={limitNudge.kind}
          limit={limitNudge.limit}
          onUpgrade={() => setUpgradeOpen(true)}
        />
      )}
        </>
      )}

      {(localsOrdered.length > 0 || session) && (
        <>
          {session && <div className="menu-sep" />}
          <div className="subhead account-vaults-head">
            <span>Local folders on this computer ({localsOrdered.length})</span>
            {session && (
              <span className="account-vaults-head-actions">
                <AsyncButton
                  className="ghost-pill sm vault-tab-add"
                  disabled={busy}
                  onClick={openExisting}
                >
                  <span>Open existing</span>
                </AsyncButton>
              </span>
            )}
          </div>
          {localsOrdered.length > 0 && (
          <ul className="member-list vault-list">
            {localsOrdered.map((r) => {
              const isCurrent = !syncEnabled && vault?.path === r.path;
              return (
                <li key={r.path}>
                  <span className="menu-swatch" aria-hidden="true">
                    {r.name[0]?.toUpperCase() ?? "?"}
                  </span>
                  <span className="member-name">
                    {r.name}
                    <span className="muted vault-folder" title={r.path}>
                      {" · Local"}
                    </span>
                  </span>
                  {confirmDeleteLocal === r.path ? (
                    <span className="vault-row-actions">
                      <span className="muted">Delete this vault?</span>
                      <button
                        className="link-btn"
                        disabled={busy}
                        onClick={() => setConfirmDeleteLocal(null)}
                      >
                        Cancel
                      </button>
                      <AsyncButton
                        className="link-btn danger"
                        disabled={busy}
                        onClick={() => deleteLocalFiles(r.path)}
                      >
                        Delete
                      </AsyncButton>
                    </span>
                  ) : (
                    <span className="vault-row-actions">
                      {isCurrent && rootMissing ? (
                        <VaultFolderMissingRowActions
                          synced={false}
                          busy={busy}
                          onRestore={() => undefined}
                          onLocate={recover(() => useStore.getState().locateVaultFolder())}
                        />
                      ) : isCurrent ? (
                        <span className="member-role">Current</span>
                      ) : (
                        <AsyncButton
                          className="link-btn"
                          disabled={busy}
                          onClick={() => switchToLocal(r.path)}
                        >
                          Switch
                        </AsyncButton>
                      )}
                      <RowActionsMenu
                        ariaLabel={`More actions for ${r.name ?? r.path}`}
                        disabled={busy}
                        actions={[
                          {
                            key: "remove",
                            label: "Remove from list",
                            title: "Remove this folder from the list. Files stay on disk.",
                            onSelect: () => removeLocalVaultRow(r.path),
                          },
                          {
                            key: "delete",
                            label: "Delete vault",
                            danger: true,
                            separated: true,
                            title: "Delete this vault — moves its folder and all its notes to the Trash",
                            onSelect: () => {
                              setActionError(null);
                              setConfirmDeleteLocal(r.path);
                            },
                          },
                        ]}
                      />
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          )}
          {foreignFootnote && <p className="muted account-vaults-footnote">{foreignFootnote}</p>}
        </>
      )}

      {session && (
        <>
          <div className="menu-sep" />
          <div className="subhead">Vault folder location</div>
          <div className="muted">New vaults are created here.</div>
          <div className="join-code-row">
            <code className="vault-root-path" title={root ?? ""}>
              {root ?? "…"}
            </code>
            <span
              className="account-vaults-info"
              role="img"
              aria-label={CURRENT_LINK_TIP}
              title={CURRENT_LINK_TIP}
            >
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 16v-4M12 8h.01" />
              </svg>
            </span>
            <button className="link-btn" onClick={() => void changeRoot()}>
              Change…
            </button>
          </div>
        </>
      )}

      {upgradeOpen && <UpgradeDialog onClose={() => setUpgradeOpen(false)} />}

      {confirmLeave && (
        <ConfirmDialog
          title={`Leave ${confirmLeave.name}?`}
          confirmLabel="Leave vault"
          onCancel={() => setConfirmLeave(null)}
          onConfirm={() => leaveVault(confirmLeave.orgId, confirmLeave.name)}
        >
          <p>
            You lose access to this vault on all your devices right away, and the
            owner is told that you left.
          </p>
          <p>
            {bound[confirmLeave.orgId] ? (
              <>
                Its folder on this device, <strong>{folderName(confirmLeave.orgId)}</strong>,
                moves to the Trash.
              </>
            ) : (
              "Nothing from it is stored on this device."
            )}{" "}
            The vault itself and everyone else's access are unchanged.
          </p>
          <p>To come back later, you'll need a new invitation or join code.</p>
          {actionError && <div className="auth-error">{actionError}</div>}
        </ConfirmDialog>
      )}

      {confirmUnsync && (
        <UnsyncConfirmDialog
          orgId={confirmUnsync.orgId}
          orgName={confirmUnsync.name}
          folderName={folderName(confirmUnsync.orgId)}
          onCancel={() => setConfirmUnsync(null)}
          onDone={() => {
            setConfirmUnsync(null);
            setBound(readOrgVaults());
          }}
        />
      )}

      {subDelete && (
        <ConfirmDialog
          title={`Delete ${subDelete.name}?`}
          confirmLabel="Delete vault"
          onCancel={() => setSubDelete(null)}
          onConfirm={() => deletePermanently(subDelete.orgId)}
        >
          <p>
            This vault is on <strong>Pro</strong>
            {subDelete.billing.currentPeriodEnd
              ? subDelete.billing.cancelAtPeriodEnd
                ? `, ending ${formatDate(subDelete.billing.currentPeriodEnd)}`
                : `, renewing ${formatDate(subDelete.billing.currentPeriodEnd)}`
              : ""}
            .
          </p>
          <p>
            Deleting it stops the subscription at the end of the current period.
            You won't be charged again, and until then you can move the
            subscription to another vault from <strong>Billing</strong>.
          </p>
          <p>
            Every note, folder and attachment in this vault is deleted for
            everyone. That part can't be undone.
          </p>
          {actionError && <div className="auth-error">{actionError}</div>}
        </ConfirmDialog>
      )}
    </>
  );
}
