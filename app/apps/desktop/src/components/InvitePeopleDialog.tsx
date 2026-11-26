import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import type { AccessGroup, InviteManyResult, TeamAccessMode, TeamAccessPosture } from "../lib/api";
import { GROUP_OPTION, groupOptionId, isGroupOption } from "../lib/groups";
import { authManager } from "../lib/auth/authManager";
import { inviteWithVaultKeys, vaultKeysJoinCode } from "../lib/vaultKeys/runtime";
import { classifyLimitError, freeLimitOf, invitePrewarning, limitFromError, peopleLimitReason, type LimitKind } from "../lib/billing";
import { buildInviteLink } from "../lib/inviteLink";
import { isValidEmail, splitEmails } from "../lib/membersAccess";
import { useStore } from "../store";
import { AsyncButton } from "./AsyncButton";
import { LimitNudge } from "./LimitNudge";
import { PeopleLimitNotice, inviteLimitError, peopleLimitKind } from "./PeopleLimitNotice";
import { MenuSelect } from "./MenuSelect";
import { toast } from "../lib/toast";
import { UpgradeDialog } from "./UpgradeDialog";

/** `default` = no level of their own: only what is shared with them or their groups. */
type InviteAccess = Exclude<TeamAccessMode, "private"> | "default";

const SEES_NOTHING = "They won't see any notes until you share something with them or add them to a group.";
/** The Access menu's values: a level, or a group to join (`group:<id>`, toggles). */
type AccessChoice = InviteAccess | `group:${string}` | "groups";

const ACCESS_LEVELS: ReadonlyArray<{ value: InviteAccess; label: string; hint?: string }> = [
  { value: "default", label: "Only what's shared", hint: "What you share with them or their groups" },
  { value: "open", label: "Can edit everything" },
  { value: "readonly", label: "Can view everything" },
];

/**
 * What someone who joins with no level of their own gets in a vault still on
 * an older New members setting (`join_default` open/readonly, a vault the
 * access model conversion has not reached yet), or null where they start on
 * Only what's shared. The server still applies that setting there.
 */
export function legacyNewMembersLine(mode?: TeamAccessMode | null): string | null {
  return mode === "open" ? "New members start on Can edit everything"
    : mode === "readonly" ? "New members start on Can view everything"
      : null;
}

/**
 * The New members setting worth passing to the dialog: only while the vault
 * still has an older Default access (`posture` edit/view, not converted yet),
 * where the server still applies it. A converted vault (sealed, or never
 * shared) gives joiners what their groups open, whatever the old setting says.
 */
export function legacyNewMembersSetting(
  posture: TeamAccessPosture | null | undefined,
  mode: TeamAccessMode | null | undefined,
): TeamAccessMode | null {
  return (posture === "edit" || posture === "view") && (mode === "open" || mode === "readonly") ? mode : null;
}

/**
 * The Access menu's levels (2026-11-25): new members start on Only what's
 * shared, so that is the default and means "no level of their own". New
 * admins start on Can edit everything, so their menu has only that. In a vault
 * still on an older New members setting the default is that setting.
 */
export function inviteAccessOptions(
  role: "member" | "admin" = "member",
  newMembers: TeamAccessMode | null = null,
): Array<{ value: InviteAccess; label: string; hint?: string; tag?: string }> {
  if (role === "admin") return [{ value: "open", label: "Can edit everything", hint: "Admins start on Can edit everything" }];
  const legacy = legacyNewMembersLine(newMembers);
  return ACCESS_LEVELS.map((o) =>
    o.value !== "default" ? o
      : legacy ? { value: "default" as const, label: "Vault default", hint: legacy, tag: "Default" }
        : { ...o, tag: "Default" });
}

/** Add typed or pasted text to the chip list, de-duplicated case-insensitively. */
export function addChips(chips: readonly string[], text: string): string[] {
  const seen = new Set(chips.map((c) => c.toLowerCase()));
  const out = [...chips];
  for (const email of splitEmails(text)) {
    if (seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    out.push(email);
  }
  return out;
}

/**
 * Invite several people at once, each with a role and an access level. One
 * request; each address reports its own outcome, using the same three
 * messages the old Members tab showed (emailed / no email server / email
 * failed, with the link to share).
 */
export function InvitePeopleDialog({ orgId, vaultName = "this vault", newMembersAccess = null, defaultKnown = true, canSetCodeGroups: canManageCode = false, canManageBilling = false, seatAccount = null, ownerName = null, groups = [], onClose, onInvited }: {
  orgId: string;
  /** For the join-code sentence. */
  vaultName?: string;
  /** The vault's New members setting (`GET access-default`); only an older open/readonly one changes what is said. */
  newMembersAccess?: TeamAccessMode | null;
  /** False until the vault's Default access is known; an unknown default never warns that someone sees nothing. */
  defaultKnown?: boolean;
  /** Owners/admins: choose the access groups the join code adds people to. */
  canSetCodeGroups?: boolean;
  /** The owner can add seats from the notice. */
  canManageBilling?: boolean;
  /** The account's seats, for the warning shown before anyone types (Team model only). */
  seatAccount?: Parameters<typeof invitePrewarning>[0] | null;
  /** The vault owner's name, so an admin knows whom to ask. */
  ownerName?: string | null;
  /** Access groups the invitees can join instead of getting a level (empty: none offered). */
  groups?: readonly AccessGroup[];
  onClose: () => void;
  /** Called with the per-address results so the roster can add rows at once. */
  onInvited: (results: InviteManyResult[], sent: { role: string; access: TeamAccessMode | null; groupIds?: string[] }) => void;
}) {
  const serverUrl = useStore((s) => s.serverUrl);
  const [chips, setChips] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [pickedAccess, setAccess] = useState<InviteAccess>("default");
  // Owners and admins start with Can edit everything (their own level, which
  // can still be lowered later); members start on the vault default. Switching
  // the role moves the Access choice along until it is picked by hand.
  const [accessPicked, setAccessPicked] = useState(false);
  // An admin can edit everything, whatever the menu held; back to Member,
  // a level picked by hand comes back.
  const chooseRole = (next: "member" | "admin") => setRole(next);
  const access: InviteAccess = role === "admin" ? "open" : accessPicked ? pickedAccess : "default";
  // Groups to join on acceptance. Picking any means no personal level: a
  // personal vault-wide level would make the groups do nothing (the server
  // refuses both together).
  const [joinGroups, setJoinGroups] = useState<string[]>([]);
  const groupIds = role === "admin" ? [] : joinGroups.filter((id) => groups.some((g) => g.id === id));
  const accessValue: AccessChoice = groupIds.length ? "groups" : access;
  const accessOptions: ReadonlyArray<{ value: AccessChoice; label: string; hint?: string; section?: string; checked?: boolean }> = [
    ...inviteAccessOptions(role, newMembersAccess),
    ...groups.map((g, i) => ({
      value: `${GROUP_OPTION}${g.id}` as const,
      label: g.name,
      hint: i === 0 ? "Joins the group and gets what it can open" : undefined,
      section: i === 0 ? "Or add to access groups" : undefined,
      checked: groupIds.includes(g.id),
    })),
  ];
  const chooseAccess = (v: AccessChoice) => {
    if (v === "groups") return;
    if (isGroupOption(v)) {
      const id = groupOptionId(v);
      setJoinGroups((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
      return;
    }
    setAccess(v as InviteAccess);
    setAccessPicked(true);
    setJoinGroups([]);
  };
  const groupsLabel = groupIds.length
    ? (() => {
        const first = groups.find((g) => g.id === groupIds[0])?.name ?? "Group";
        return groupIds.length === 1 ? first : `${first} + ${groupIds.length - 1}`;
      })()
    : null;
  const [code, setCode] = useState<string | null>(null);
  const shortCode = code ? code.split("-")[0]! : "";
  const [results, setResults] = useState<InviteManyResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState<{ kind: LimitKind; limit: number | null } | null>(null);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [peopleErr, setPeopleErr] = useState<unknown>(null);
  // Redesign: email and join code each get a tab of their own.
  const [tab, setTab] = useState<"email" | "code">("email");
  const [copied, setCopied] = useState(false);

  // The access groups the join code adds people to; null until known, and on
  // a server that cannot set them (no groups section then).
  const [codeGroups, setCodeGroups] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    authManager.api
      .getJoinCodeInfo()
      .then((info) => {
        if (live) setCodeGroups(info.groupIds);
        return vaultKeysJoinCode(orgId, info.code);
      })
      .then((c) => { if (live) setCode(c); })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  const codeGroupIds = (codeGroups ?? []).filter((id) => groups.some((g) => g.id === id));
  const toggleCodeGroup = (id: string) => {
    if (codeGroups === null) return;
    const prev = codeGroups;
    const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
    setCodeGroups(next);
    authManager.api
      .setJoinCodeGroups(orgId, next)
      .then((saved) => setCodeGroups(saved))
      .catch((e) => {
        setCodeGroups(prev);
        toast(e instanceof Error ? e.message : "Couldn't change the join code's groups.", "error");
      });
  };
  type CodeChoice = `group:${string}` | "groups";
  const canSetCodeGroups = canManageCode && codeGroups !== null && groups.length > 0;
  const codeOptions: ReadonlyArray<{ value: CodeChoice; label: string; hint?: string; checked?: boolean }> = groups.map((g, i) => ({
    value: `${GROUP_OPTION}${g.id}` as const,
    label: g.name,
    hint: g.autoJoin ? "Takes new members automatically" : i === 0 ? "Joins the group and gets what it can open" : undefined,
    checked: g.autoJoin || codeGroupIds.includes(g.id),
  }));
  // Groups that take every new member are joined anyway; the code adds its own.
  const autoJoinNames = groups.filter((g) => g.autoJoin).map((g) => g.name);
  const joinedByCode = [...new Set([...autoJoinNames, ...codeGroupIds.map((id) => groups.find((g) => g.id === id)?.name ?? "Group")])];
  const codeGroupsLabel = joinedByCode.length
    ? joinedByCode.length === 1 ? joinedByCode[0]! : `${joinedByCode[0]} + ${joinedByCode.length - 1}`
    : "No group";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !upgradeOpen) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, upgradeOpen]);

  const commitDraft = () => {
    if (!draft.trim()) return;
    setChips((c) => addChips(c, draft));
    setDraft("");
  };

  const all = draft.trim() ? addChips(chips, draft) : chips;
  const invalid = all.filter((e) => !isValidEmail(e));

  const send = async () => {
    setError(null);
    setLimit(null);
    setPeopleErr(null);
    if (all.length === 0 || invalid.length > 0) return;
    setChips(all);
    setDraft("");
    try {
      const sentAccess: TeamAccessMode | null = groupIds.length || access === "default" ? null : access;
      const out = await inviteWithVaultKeys(orgId, {
        emails: all,
        role,
        access: sentAccess,
        ...(groupIds.length ? { groupIds } : {}),
      });
      setResults(out);
      setChips(out.filter((r) => r.error).map((r) => r.email));
      onInvited(out, { role, access: sentAccess, ...(groupIds.length ? { groupIds } : {}) });
      void useStore.getState().refreshVault();
    } catch (e) {
      const kind = classifyLimitError(e);
      if (peopleLimitKind(e)) setPeopleErr(e);
      else if (kind) setLimit({ kind, limit: limitFromError(e) });
      else setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Nothing to open yet: they'd land on an empty sidebar (unless a group
  // takes every new member).
  const legacyNewMembers = legacyNewMembersLine(newMembersAccess);
  const emailWarning = role === "member" && !groupIds.length && access === "default" && autoJoinNames.length === 0 && !legacyNewMembers && defaultKnown
    ? SEES_NOTHING
    : null;

  const prewarning = seatAccount ? invitePrewarning(seatAccount, ownerName, canManageBilling) : null;

  // A people limit is ONE notice, whether the whole call was refused or some
  // addresses were: the per-address rows below drop the raw code for it.
  const peopleNotice =
    peopleErr ?? results?.map((r) => (r.error ? inviteLimitError(r.error) : null)).find((x) => x != null) ?? null;

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); } catch { /* clipboard unavailable */ }
  };
  const copyCode = async () => {
    if (!code) return;
    await copy(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return createPortal(
    <div className="modal-backdrop" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div className="modal invite-people" role="dialog" aria-modal="true" aria-label="Invite people" onClick={(e) => e.stopPropagation()}>
        <div className="invite-head">
          <h2 className="confirm-title">Invite people</h2>
          <button type="button" className="invite-close" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <div className="invite-tabs" role="tablist" aria-label="How to invite">
          <button type="button" role="tab" aria-selected={tab === "email"} className={tab === "email" ? "on" : ""} onClick={() => setTab("email")}>By email</button>
          <button type="button" role="tab" aria-selected={tab === "code"} className={tab === "code" ? "on" : ""} onClick={() => setTab("code")}>Join code</button>
        </div>
        {tab === "code" ? (
          <>
            <div className="invite-code-card">
              <p className="invite-code-lead">Anyone with this code can join {vaultName}</p>
              {code ? (
                <>
                  {/* Tiles show the vault's 8-character code; a device that holds the
                      vault key appends `-<key>` (26 chars), which only travels by Copy. */}
                  <div className="invite-code-tiles" aria-label={`Join code ${code}`}>
                    {shortCode.split("").map((ch, i) => (
                      <span key={i} className={i === Math.floor(shortCode.length / 2) ? "gap" : undefined}>{ch}</span>
                    ))}
                  </div>
                  {shortCode !== code && (
                    <p className="invite-code-note">Copy it to share: the copied code includes a key, so they get in right away.</p>
                  )}
                </>
              ) : (
                <p className="invite-code-lead">Loading the code…</p>
              )}
              <button type="button" className={`primary invite-copy${copied ? " is-copied" : ""}`} disabled={!code} onClick={() => void copyCode()}>
                {copied ? "Copied" : "Copy code"}
              </button>
            </div>
            <div className="invite-code-row">
              <span>
                People who join are added to
                <small>{legacyNewMembers ? `${legacyNewMembers}${groups.length ? ", plus what these groups open" : ""}` : groups.length ? "They get what these groups open, and anything shared with them" : "They get only what is shared with them"}</small>
              </span>
              {canSetCodeGroups ? (
                <MenuSelect<CodeChoice>
                  value="groups"
                  options={codeOptions}
                  onSelect={(v) => {
                    if (!isGroupOption(v)) return;
                    const id = groupOptionId(v);
                    if (groups.find((g) => g.id === id)?.autoJoin) return;
                    toggleCodeGroup(id);
                  }}
                  ariaLabel="People who join are added to"
                  triggerClassName="invite-field-trigger"
                  menuClassName="access-menu"
                  triggerContent={<span className="role-trigger-label">{codeGroupsLabel}</span>}
                />
              ) : (
                <span className="muted">{codeGroupsLabel}</span>
              )}
            </div>
          </>
        ) : (<>
        <div className="invite-chips" onClick={(e) => (e.currentTarget.querySelector("input") as HTMLInputElement | null)?.focus()}>
          {chips.map((c) => (
            <span key={c} className={`invite-chip${isValidEmail(c) ? "" : " is-invalid"}`}>
              {c}
              <button type="button" aria-label={`Remove ${c}`} onClick={() => setChips((cs) => cs.filter((x) => x !== c))}>×</button>
            </span>
          ))}
          <input
            type="text"
            autoFocus
            value={draft}
            placeholder={chips.length ? "" : "Emails, separated by commas"}
            aria-label="Email addresses"
            onChange={(e) => {
              const v = e.target.value;
              if (/[\s,;]$/.test(v)) { setChips((c) => addChips(c, v)); setDraft(""); }
              else setDraft(v);
            }}
            onPaste={(e) => {
              const text = e.clipboardData.getData("text");
              if (!/[\s,;]/.test(text)) return;
              e.preventDefault();
              setChips((c) => addChips(c, draft + text));
              setDraft("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commitDraft(); }
              else if (e.key === "Backspace" && !draft && chips.length) setChips((c) => c.slice(0, -1));
            }}
            onBlur={commitDraft}
          />
        </div>
        {invalid.length > 0 && (
          <div className="auth-error">{invalid.length === 1 ? `“${invalid[0]}” isn't an email address.` : `${invalid.length} entries aren't email addresses.`}</div>
        )}
        <div className="invite-people-fields">
          <label className="invite-field">
            <span className="invite-field-label">Role</span>
            <MenuSelect
              value={role}
              options={[{ value: "member", label: "Member" }, { value: "admin", label: "Admin", hint: "Can manage people and access" }]}
              onSelect={chooseRole}
              ariaLabel="Role"
              triggerClassName="invite-field-trigger"
              menuClassName="access-menu"
              anchorClosest=".invite-field"
            />
          </label>
          <label className="invite-field">
            <span className="invite-field-label">Access</span>
            <MenuSelect<AccessChoice>
              value={accessValue}
              options={accessOptions}
              onSelect={chooseAccess}
              ariaLabel="Access"
              triggerClassName="invite-field-trigger"
              menuClassName="access-menu"
              anchorClosest=".invite-field"
              disabled={role === "admin"}
              triggerContent={groupsLabel ? <span className="role-trigger-label">{groupsLabel}</span> : undefined}
            />
          </label>
        </div>
        {error && <div className="auth-error">{error}</div>}
        {prewarning && !results && peopleNotice == null && (
          <div className="limit-nudge">
            <span>{prewarning.text}</span>
            {prewarning.action === "add-seats" && (
              <button type="button" className="link-btn" onClick={() => useStore.getState().requestAccountSettings("plan")}>
                Add seats
              </button>
            )}
            {prewarning.action === "upgrade" && (
              <button
                type="button"
                className="link-btn"
                onClick={() => useStore.getState().requestUpgradeDialog({ reason: peopleLimitReason(seatAccount ? freeLimitOf(seatAccount) : null) })}
              >
                Upgrade →
              </button>
            )}
          </div>
        )}
        {peopleNotice != null && <PeopleLimitNotice error={peopleNotice} canManageBilling={canManageBilling} ownerName={ownerName} freeLimit={seatAccount ? freeLimitOf(seatAccount) : null} />}
        {limit && <LimitNudge kind={limit.kind} limit={limit.limit} onUpgrade={() => setUpgradeOpen(true)} />}
        {results?.map((r) => {
          const link = r.invitationId ? buildInviteLink(serverUrl, r.invitationId) : null;
          return (
            <div key={r.email} className={`invite-notice${r.error ? " is-warning" : ""}`}>
              {r.emailed ? (
                <span>Invitation emailed to {r.email}.</span>
              ) : !r.invitationId ? (
                <span>Couldn't invite {r.email}{r.error && !inviteLimitError(r.error) ? ` (${r.error})` : ""}.</span>
              ) : (
                <>
                  <span>
                    {r.error
                      ? `Invitation created, but the email to ${r.email} couldn't be sent (${r.error}). Share this link instead:`
                      : `Invitation created. This server doesn't send email, so share this link with ${r.email}:`}
                  </span>
                  {link && (
                    <div className="invite-notice-link">
                      <code>{link}</code>
                      <button className="link-btn" onClick={() => void copy(link)}>Copy</button>
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
        <div className="invite-foot">
          <span className={`invite-foot-hint${emailWarning ? " is-warning" : ""}`}>{emailWarning ?? "They get an email with a link."}</span>
          <div className="confirm-actions invite-people-actions">
            <button type="button" className="ghost-pill" onClick={onClose}>{results ? "Done" : "Cancel"}</button>
            <AsyncButton
              className="primary"
              spinnerTone="on-accent"
              disabled={all.length === 0 || invalid.length > 0}
              onClick={send}
            >
              {all.length >= 2 ? `Send ${all.length} invites` : "Send invite"}
            </AsyncButton>
          </div>
        </div>
        </>)}
        {upgradeOpen && <UpgradeDialog onClose={() => setUpgradeOpen(false)} />}
      </div>
    </div>,
    document.body,
  );
}
