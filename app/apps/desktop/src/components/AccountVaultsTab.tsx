/* Account Settings → Vaults. Vaults belong to the account (owner decision
   2026-10-07), so the one list of them lives here rather than in Vault
   Settings: the synced vaults this account is a member of, the local folders
   this app profile has opened, and where new vault folders go. Moved verbatim
   from the old Vault Settings → Vaults tab; the people/notes counts come from
   the account's billing usage when the server bills per seat. Rows carry no
   plan pill (the plan is the account's, said in Plan & Billing); only a
   lapsed account's vaults get a "Read-only" pill, since that changes the row. */
import { Fragment, useEffect, useState } from "react";
import { ApiError, type BillingUsage, type MyBillingAccount, type OrgBilling } from "../lib/api";
import { toast } from "../lib/toast";
import { folderErrorText } from "../lib/vault/folderErrors";
import { authManager } from "../lib/auth/authManager";
import { classifyLimitError, type LimitKind, limitFromError } from "../lib/billing";
import * as ipc from "../lib/ipc";
import { readOrgVaults, useStore } from "../store";
import { AsyncButton } from "./AsyncButton";
import { InvitationRows, useFreshInvitations } from "./InvitationRows";
import { ConfirmDialog } from "./ConfirmDialog";
import { LOCATE_FOLDER, RESTORE_HERE, VaultFolderMissingRowActions } from "./VaultFolderMissing";
import { useResetLocalCopy } from "./useResetLocalCopy";
import { type RowAction, RowActionsMenu } from "./RowActionsMenu";
import { VaultTile } from "./VaultSwitcher";
import {
  CARD_FOLDER_MISSING,
  type CardMetaPart,
  folderMissingCardActions,
  localCardLabels,
  matchesVaultQuery,
  orderSyncedVaults,
  RECENT_VAULT_CARDS,
  isDefaultVaultsRoot,
  shortFolderPath,
  syncedCardMeta,
  vaultSlugLabel,
  visibleSyncedVaults,
  type VaultsScope,
} from "../lib/accountVaultsView";
import { LimitNudge } from "./LimitNudge";
import { UpgradeDialog } from "./UpgradeDialog";
import { useLocalFolderClasses, useLocalVaults, useRecentVaults } from "./useVaultLists";
import { hiddenForeignFootnote, visibleFolders } from "../lib/vault/vaultList";
import { formatDate, UnsyncConfirmDialog } from "./VaultSettingsDialog";
import { AccountVaultPage } from "./AccountVaultPage";
import {
  vaultPageDetails,
  vaultPagePlanLine,
  vaultPageRole,
  vaultSettingsAction,
} from "../lib/accountVaultPage";

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
  // The full recents list, for "the 6 you opened last" (by each vault's folder).
  const recents = useRecentVaults(localsNonce);
  // Role and owner per vault, from the billing listing (null with billing off).
  const myBilling = useStore((s) => s.myBilling);
  useEffect(() => {
    if (session) void useStore.getState().refreshMyBilling();
  }, [session]);
  const { classes: folderClasses, resolved: foldersResolved } = useLocalFolderClasses(
    locals,
    session ? organizations.map((o) => o.id) : [],
  );

  const [root, setRoot] = useState<string | null>(null);
  const [rootError, setRootError] = useState<string | null>(null);
  const [bound, setBound] = useState<Record<string, string>>(() => readOrgVaults());
  const [creating, setCreating] = useState(false);
  const [orgName, setOrgName] = useState("");
  const [joining, setJoining] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The vault whose permanent deletion is awaiting the standard confirm dialog.
  const [confirmDelete, setConfirmDelete] = useState<{ orgId: string; name: string } | null>(
    null,
  );
  // A vault that is actually PAYING, whose deletion needs the full dialog
  // instead: the two-click row has nowhere to say what happens to the money
  // (#111). Its billing snapshot rides along so the copy can name the date.
  const [subDelete, setSubDelete] = useState<
    { orgId: string; name: string; billing: OrgBilling } | null
  >(null);
  // The local vault whose folder deletion is awaiting the standard confirm dialog.
  const [confirmDeleteLocal, setConfirmDeleteLocal] = useState<
    { path: string; name: string } | null
  >(null);
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
  // The vault whose page is open (a card was clicked); null = the list.
  const [pageOrgId, setPageOrgId] = useState<string | null>(null);
  const [vaultQuery, setVaultQuery] = useState("");
  // All / Synced / Local: which sections the page shows.
  const [scope, setScope] = useState<VaultsScope>("all");
  // Synced cards past the six opened last are folded behind "Show all".
  const [showAll, setShowAll] = useState(false);
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
  // True until the usage answers (or fails): the vault page shows skeletons.
  const [billingLoading, setBillingLoading] = useState(false);
  const usageShown = !!session && billingConfig?.enabled === true && billingConfig.model === "team";
  useEffect(() => {
    if (!session || !billingConfig?.enabled || billingConfig.model !== "team") {
      setBilling(null);
      setBillingLoading(false);
      return;
    }
    let live = true;
    setBillingLoading(true);
    Promise.all([authManager.api.getBillingAccount(), authManager.api.getBillingUsage()])
      .then(([account, usage]) => { if (live) setBilling({ account, usage }); })
      .catch(() => { if (live) setBilling(null); })
      .finally(() => { if (live) setBillingLoading(false); });
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
      .catch((e) => {
        // Show WHY there is no root (e.g. macOS blocked Documents), not "…".
        if (!cancelled) setRootError(folderErrorText(e));
      });
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
   * other vault gets the plain ConfirmDialog below; nothing confirms inline,
   * so a card never changes shape while a confirm is pending.
   *
   * A billing lookup that fails is treated as free — an unreachable billing
   * endpoint must not block a delete the user is entitled to make.
   */
  const askDelete = async (orgId: string, name: string) => {
    setActionError(null);
    // Team model: the subscription is the owner's account, and deleting a
    // vault does not touch it, so there is no subscription to warn about.
    if (!billingEnabled || teamBilling) {
      setConfirmDelete({ orgId, name });
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
      setConfirmDelete({ orgId, name });
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
            ? `Vault deleted. Pro ends on ${formatDate(ends)}. Move it from Billing if you want to keep it.`
            : "Vault deleted. Pro ends when the current period does. Move it from Billing if you want to keep it.",
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
      toast(cancelFailed ? message : `Couldn't delete the vault: ${message}`, "error");
    } finally {
      setBusy(false);
    }
  };

  // Leave a vault someone else owns (confirmed above). Server first, then the
  // vault leaves this device entirely; the dialog stays open on failure so the
  // server's reason (an owner's 409, offline) has somewhere to show.
  const leaveVault = async (orgId: string, _name: string) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await useStore.getState().leaveVault(orgId);
      setBound(readOrgVaults());
      setConfirmLeave(null);
      // The store shows the one "You left <vault>" notice after the cleanup.
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setActionError(message);
      toast(`Couldn't leave the vault: ${message}`, "error");
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

  // A local folder's ⋯ actions, shared by its list row and its grid card.
  const localActions = (path: string, name: string): RowAction[] => [
    {
      key: "remove",
      label: "Remove from list",
      title: "Remove this folder from the list. Files stay on disk.",
      onSelect: () => removeLocalVaultRow(path),
    },
    {
      key: "delete",
      label: "Delete vault",
      danger: true,
      separated: true,
      title: "Delete this vault: moves its folder and all its notes to the Trash",
      onSelect: () => {
        setActionError(null);
        setConfirmDeleteLocal({ path, name });
      },
    },
  ];

  // Move a local vault's folder to the OS trash (destructive, confirmed in a dialog).
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
      // A new vault starts LOCAL (owner decision 2026-11-20), exactly like the
      // vault switcher's New vault: a folder under the vaults root, opened and
      // switched to, with the first-run notes. Syncing it is a separate,
      // explicit step (Turn on sync), never a side effect of creating it.
      const parent = await ipc.getVaultsRoot();
      const v = await ipc.createVault(parent, orgName.trim());
      await useStore.getState().adoptOpenedVault(v, { seed: true });
      setOrgName("");
      setCreating(false);
      setBound(readOrgVaults());
      setLocalsNonce((n) => n + 1);
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

  // Both go through Rust's refusal of the home folder, its parents and the
  // top of the disk; a refusal (or a blocked Documents) is shown as a toast.
  const changeRoot = async () => {
    try {
      const picked = await ipc.pickVaultsRoot();
      if (picked) {
        setRoot(picked);
        setRootError(null);
      }
    } catch (e) {
      toast(folderErrorText(e), "error");
    }
  };
  const resetRoot = async () => {
    try {
      setRoot(await ipc.resetVaultsRoot());
      setRootError(null);
    } catch (e) {
      const text = folderErrorText(e);
      setRootError(text);
      toast(text, "error");
    }
  };

  // The ⋯ menu of a synced vault, shared by its row and its card.
  const syncedActions = (o: { id: string; name: string }, isActive: boolean): RowAction[] => [
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
          title: "Leave this vault. You lose access and it is removed from this device",
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
  ];

  // A confirm dialog that is open shows the action's error itself; the page's
  // banner would only repeat it behind the dialog.
  const errorInDialog = !!(confirmDelete || confirmDeleteLocal || confirmLeave || subDelete);

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

  // Recency per synced vault: when this device last opened its bound folder.
  const openedAtByOrg: Record<string, number> = {};
  for (const o of organizations) {
    const p = bound[o.id];
    const r = p ? recents.find((x) => x.path === p) : undefined;
    if (r) openedAtByOrg[o.id] = r.openedAt;
  }
  const openOrgId = organizations.find((o) => isOpenOrg(o.id))?.id ?? null;
  const syncedOrdered = orderSyncedVaults(organizations, { openOrgId, openedAtByOrg });
  // Choosing Synced asks for the synced list, so it shows whole; only All
  // folds it to the ones opened last.
  const listAll = showAll || scope === "synced";
  const { shown: syncedShown, hidden: syncedHidden } = visibleSyncedVaults(syncedOrdered, {
    query: vaultQuery,
    showAll: listAll,
  });
  const localsMatching = localsOrdered.filter((r) => matchesVaultQuery(r.name ?? r.path, vaultQuery));
  const totalVaults = (session ? organizations.length : 0) + localsOrdered.length;
  const showSynced = !!session && scope !== "local";
  const showLocal = !session || scope !== "synced";

  // What the server told us about each vault: the caller's role and its owner.
  // The open vault's member list wins; otherwise the billing listing (absent
  // with billing off, so those cards simply show no role).
  const myRoleIn = (orgId: string): string | null => {
    if (orgId === activeOrgId) {
      const mine = members.find((m) => m.userId === session?.user.id)?.role;
      if (mine) return mine;
    }
    return myBilling?.vaults.find((v) => v.orgId === orgId)?.role ?? null;
  };
  const ownerNameOf = (orgId: string): string | null => {
    if (orgId === activeOrgId) {
      const owner = members.find((m) => m.role === "owner");
      if (owner) return owner.user?.name || null;
    }
    return myBilling?.vaults.find((v) => v.orgId === orgId)?.billingOwner?.name ?? null;
  };

  const scopeSwitch = (
    <span className="vaults-scope" role="tablist" aria-label="Which vaults">
      {(
        [
          ["all", "All", totalVaults],
          ["synced", "Synced", organizations.length],
          ["local", "Local", localsOrdered.length],
        ] as const
      ).map(([id, label, n]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={scope === id}
          className={scope === id ? "is-on" : undefined}
          onClick={() => setScope(id)}
        >
          {label} <b>{n}</b>
        </button>
      ))}
    </span>
  );

  const metaLine = (parts: CardMetaPart[]) => (
    <span className="vaults-card-meta">
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="vaults-card-sep" aria-hidden="true">·</span>}
        <span className={`vaults-card-part${p.tone ? ` is-${p.tone}` : ""}`}>
          {p.tone === "open" && <span className="vaults-card-dot" aria-hidden="true" />}
          {p.tone === "cloud" && (
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
            </svg>
          )}
          {p.text}
        </span>
        </Fragment>
      ))}
    </span>
  );

  // The open vault page, when a card was clicked and the vault still exists.
  const pageOrg = session && pageOrgId ? organizations.find((o) => o.id === pageOrgId) ?? null : null;
  const renderPage = (o: (typeof organizations)[number]) => {
    const isActive = isOpenOrg(o.id);
    const usage = usageFor(o.id);
    const onMyAccount = !!usage;
    const activeMembers = o.id === activeOrgId ? members : [];
    const role = vaultPageRole({
      activeRole: activeMembers.find((m) => m.userId === session?.user.id)?.role ?? null,
      onMyAccount,
    });
    const ownerName = activeMembers.find((m) => m.role === "owner")?.user?.name || null;
    const planLine = usageShown
      ? vaultPagePlanLine({ onMyAccount, accountPlan: billing?.account.plan ?? null, ownerName })
      : null;
    const settingsAction = vaultSettingsAction({ isOpen: isActive, boundPath: bound[o.id] ?? null });
    return (
      <AccountVaultPage
        orgId={o.id}
        name={o.name}
        slug={vaultSlugLabel(o)}
        isCurrent={isActive}
        lapsed={!!usage && accountLapsed}
        busy={busy}
        showStats={usageShown}
        usage={usage}
        usageLoading={billingLoading}
        details={vaultPageDetails({
          role,
          planLine,
          folderPath: bound[o.id] ?? null,
          createdAt: o.createdAt,
          formatDate,
        })}
        actions={syncedActions(o, isActive)}
        folderMissing={
          isActive && rootMissing ? (
            <VaultFolderMissingRowActions
              synced={syncEnabled}
              busy={busy}
              onRestore={recover(() => useStore.getState().restoreVaultFolder())}
              onLocate={recover(() => useStore.getState().locateVaultFolder())}
            />
          ) : null
        }
        settingsAction={settingsAction}
        onSwitch={() => switchTo(o.id)}
        onOpenSettings={async () => {
          // The Plan tab's invited-chip rule: switch first when needed, then
          // Vault Settings → Members and access.
          if (settingsAction === "unavailable") return;
          if (settingsAction === "switch-then-open") {
            await switchTo(o.id);
            if (useStore.getState().session?.activeOrganizationId !== o.id) return;
          }
          useStore.getState().requestSettings("members");
        }}
        onBack={() => setPageOrgId(null)}
      />
    );
  };

  const headerActions = (
    <span className="account-vaults-head-actions">
      {!creating && !joining && (
        <>
          <AsyncButton className="secondary vault-hdr-btn" disabled={busy} onClick={openExisting}>
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
            </svg>
            <span>Open folder</span>
          </AsyncButton>
          {session && (
            <>
              <button type="button" className="secondary vault-hdr-btn" onClick={() => setJoining(true)}>
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" />
                </svg>
                <span>Join with code</span>
              </button>
            </>
          )}
            <button type="button" className="primary vault-hdr-btn" onClick={() => setCreating(true)}>
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
              <span>New vault</span>
            </button>
        </>
      )}
      {/* The form opens where its buttons were, so nothing else moves. */}
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
              <button type="submit" className="primary" disabled={busy || !orgName.trim()}>
                Create
              </button>
              <button type="button" className="ghost-pill" disabled={busy} onClick={() => setCreating(false)}>
                Cancel
              </button>
            </form>
          ) : (
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
              <button type="submit" className="primary" disabled={busy || !joinCode.trim()}>
                Join
              </button>
              <button type="button" className="ghost-pill" disabled={busy} onClick={() => setJoining(false)}>
                Cancel
              </button>
            </form>
          )}
        </div>
      )}
    </span>
  );

  return (
    <>
      {pageOrg ? (
        <>
          <h2 className="settings-section-title">Vaults</h2>
          {renderPage(pageOrg)}
          {actionError && !errorInDialog && <div className="auth-error">{actionError}</div>}
        </>
      ) : (
        <div className="vaults-page">
          <div className="vaults-page-head">
            <div className="vaults-page-title">
              <h2 className="settings-section-title">Vaults</h2>
              <p className="vaults-page-sub">
                {session
                  ? "Every vault on your account and on this device."
                  : "Vaults on this device. Sign in to see your synced vaults."}
              </p>
            </div>
            {headerActions}
          </div>
          {joinError && <div className="auth-error">{joinError}</div>}

          {session && userInvitations.length > 0 && (
            <>
              <div className="vaults-section-head">
                <span>
                  Invitations <b>{userInvitations.length}</b>
                </span>
              </div>
              <div className="account-vaults-invites">
                <InvitationRows invitations={userInvitations} freshIds={freshInviteIds} />
              </div>
            </>
          )}

          <div className="vaults-page-filters">
            <label className="vaults-search-box">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              <input
                type="search"
                placeholder={`Search ${plural(totalVaults, "vault", "vaults")}`}
                aria-label="Search vaults"
                value={vaultQuery}
                onChange={(e) => setVaultQuery(e.target.value)}
              />
            </label>
            {session && scopeSwitch}
          </div>

          {showSynced && (
            <section className="vaults-section" aria-label="Synced vaults">
              <div className="vaults-section-head">
                <span>
                  Synced vaults <b>{organizations.length}</b>
                </span>
                {syncedHidden > 0 && (
                  <span className="vaults-section-note">
                    Showing the {RECENT_VAULT_CARDS} you opened last
                  </span>
                )}
              </div>
              {syncedShown.length === 0 ? (
                <p className="vaults-empty-line">
                  {vaultQuery.trim()
                    ? "No synced vaults match."
                    : "No synced vaults yet. Create one with New vault, or join a team with a code."}
                </p>
              ) : (
                <div className="vaults-cards">
                  {syncedShown.map((o) => {
                    const isOpen = isOpenOrg(o.id);
                    const missing = isOpen && rootMissing;
                    const usage = usageFor(o.id);
                    const parts = syncedCardMeta({
                      isOpen,
                      role: myRoleIn(o.id),
                      onDevice: !!bound[o.id],
                      folderMissing: missing,
                      usage: usage ? { people: usage.people, notes: usage.notes } : null,
                      ownerName: ownerNameOf(o.id),
                    });
                    if (usage && accountLapsed) parts.push({ text: "Read-only", tone: "danger" });
                    const menu = syncedActions(o, isOpen);
                    const missingChip = missing ? folderMissingCardActions(syncEnabled) : null;
                    if (missingChip?.menu.includes("locate")) {
                      menu.unshift({
                        key: "locate",
                        label: LOCATE_FOLDER,
                        onSelect: recover(() => useStore.getState().locateVaultFolder()),
                      });
                    }
                    return (
                      <div
                        key={o.id}
                        role="button"
                        tabIndex={0}
                        className={`vaults-card${isOpen ? " is-open" : ""}`}
                        title={o.name}
                        onClick={() => setPageOrgId(o.id)}
                        onKeyDown={(e) => {
                          if (e.target !== e.currentTarget) return;
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setPageOrgId(o.id);
                          }
                        }}
                      >
                        <VaultTile identity={`org:${o.id}`} name={o.name} />
                        <span className="vaults-card-text">
                          <span className="vaults-card-name">{o.name}</span>
                          {metaLine(parts)}
                        </span>
                        <span
                          className={`vaults-card-actions${missingChip ? " is-pinned" : ""}`}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                        >
                          {missingChip ? (
                            <AsyncButton
                              className="vaults-card-open"
                              disabled={busy}
                              onClick={
                                missingChip.chip === "restore"
                                  ? recover(() => useStore.getState().restoreVaultFolder())
                                  : recover(() => useStore.getState().locateVaultFolder())
                              }
                            >
                              {missingChip.chip === "restore" ? RESTORE_HERE : LOCATE_FOLDER}
                            </AsyncButton>
                          ) : (
                            !isOpen && (
                              <AsyncButton
                                className="vaults-card-open"
                                disabled={busy}
                                onClick={() => switchTo(o.id)}
                              >
                                Open
                              </AsyncButton>
                            )
                          )}
                          <RowActionsMenu
                            ariaLabel={`More actions for ${o.name}`}
                            disabled={busy}
                            actions={menu}
                          />
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
              {(syncedHidden > 0 || (showAll && scope === "all" && !vaultQuery.trim() && organizations.length > RECENT_VAULT_CARDS)) && (
                <button type="button" className="link-btn vaults-show-all" onClick={() => setShowAll((v) => !v)}>
                  {showAll ? "Show fewer" : `Show all ${organizations.length} synced vaults`}
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={showAll ? "is-up" : undefined}>
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </button>
              )}
              {freeVaultLimit != null && (
                <p className="muted">
                  Free includes {plural(freeVaultLimit, "synced vault", "synced vaults")} on this account
                  {baseFreeVaults != null && freeVaultLimit > baseFreeVaults
                    ? " (includes vaults you had before)"
                    : ""}
                  .
                </p>
              )}
              {limitNudge && (
                <LimitNudge
                  kind={limitNudge.kind}
                  limit={limitNudge.limit}
                  onUpgrade={() => setUpgradeOpen(true)}
                />
              )}
            </section>
          )}

          {showLocal && (
            <section className="vaults-section" aria-label="Local vaults">
              <div className="vaults-section-head">
                <span>
                  Local vaults <b>{localsOrdered.length}</b>
                </span>
              </div>
              {localsMatching.length === 0 ? (
                <p className="vaults-empty-line">
                  {vaultQuery.trim() && localsOrdered.length > 0
                    ? "No local vaults match."
                    : "No local vaults yet. Folders you open on this computer without syncing show up here."}
                </p>
              ) : (
                <div className="vaults-cards">
                  {localsMatching.map((r) => {
                    const isCurrent = !syncEnabled && vault?.path === r.path;
                    const missing = isCurrent && rootMissing;
                    const labels = localCardLabels(r);
                    const parts: CardMetaPart[] = [
                      ...(isCurrent ? [{ text: "Current", tone: "open" as const }] : []),
                      missing
                        ? { text: CARD_FOLDER_MISSING, tone: "danger" as const }
                        : { text: shortFolderPath(r.path) },
                    ];
                    const open = () => (isCurrent ? undefined : switchToLocal(r.path));
                    return (
                      <div
                        key={r.path}
                        role="button"
                        tabIndex={0}
                        className={`vaults-card${isCurrent ? " is-open" : ""}`}
                        title={r.path}
                        onClick={() => void open()}
                        onKeyDown={(e) => {
                          if (e.target !== e.currentTarget) return;
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            void open();
                          }
                        }}
                      >
                        <span className="menu-swatch vault-grid-letter" aria-hidden="true">
                          {labels.letter}
                        </span>
                        <span className="vaults-card-text">
                          <span className="vaults-card-name">{labels.name}</span>
                          {metaLine(parts)}
                        </span>
                        <span
                          className={`vaults-card-actions${missing ? " is-pinned" : ""}`}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                        >
                          {missing ? (
                            <AsyncButton
                              className="vaults-card-open"
                              disabled={busy}
                              onClick={recover(() => useStore.getState().locateVaultFolder())}
                            >
                              {LOCATE_FOLDER}
                            </AsyncButton>
                          ) : (
                            !isCurrent && (
                              <AsyncButton
                                className="vaults-card-open"
                                disabled={busy}
                                onClick={() => switchToLocal(r.path)}
                              >
                                Open
                              </AsyncButton>
                            )
                          )}
                          <RowActionsMenu
                            ariaLabel={`More actions for ${r.name ?? r.path}`}
                            disabled={busy}
                            actions={localActions(r.path, r.name ?? r.path)}
                          />
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
              {foreignFootnote && <p className="muted account-vaults-footnote">{foreignFootnote}</p>}
            </section>
          )}

          {actionError && !errorInDialog && <div className="auth-error">{actionError}</div>}

          {session && (
            <div className="vaults-root">
              <span className="vaults-root-label">New vaults are created in</span>
              <span
                className="vaults-root-path"
                title={
                  root
                    ? `${root}\n\nBaalda also keeps a shortcut named “current” here that always points to the open vault, so an AI app can use one fixed path.`
                    : (rootError ?? "")
                }
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
                </svg>
                {root ? shortFolderPath(root) : rootError ? "Not available" : "…"}
              </span>
              <button className="link-btn" onClick={() => void changeRoot()}>
                Change
              </button>
              {root && !isDefaultVaultsRoot(root) && (
                <button className="link-btn vaults-root-reset" onClick={() => void resetRoot()}>
                  Reset to default
                </button>
              )}
              {rootError && <span className="error">{rootError}</span>}
            </div>
          )}
        </div>
      )}
      {reset.dialog}

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
                is permanently deleted, including any changes that haven't synced. It
                does not go to the Trash.
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

      {confirmDelete && (
        <ConfirmDialog
          title={`Delete ${confirmDelete.name}?`}
          confirmLabel="Delete vault"
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => deletePermanently(confirmDelete.orgId)}
        >
          <p>
            Every note, folder and attachment in this vault is deleted for
            everyone, and this device's folder moves to the Trash. This can't
            be undone.
          </p>
          {actionError && <div className="auth-error">{actionError}</div>}
        </ConfirmDialog>
      )}

      {confirmDeleteLocal && (
        <ConfirmDialog
          title={`Delete ${confirmDeleteLocal.name}?`}
          confirmLabel="Delete vault"
          onCancel={() => setConfirmDeleteLocal(null)}
          onConfirm={() => deleteLocalFiles(confirmDeleteLocal.path)}
        >
          <p>This vault's folder and all its notes move to the Trash.</p>
          {actionError && <div className="auth-error">{actionError}</div>}
        </ConfirmDialog>
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
            everyone, and this device's folder moves to the Trash. That part
            can't be undone.
          </p>
          {actionError && <div className="auth-error">{actionError}</div>}
        </ConfirmDialog>
      )}
    </>
  );
}


