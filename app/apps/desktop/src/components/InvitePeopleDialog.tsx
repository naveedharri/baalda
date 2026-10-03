import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import type { InviteManyResult, TeamAccessMode } from "../lib/api";
import { authManager } from "../lib/auth/authManager";
import { classifyLimitError, limitFromError, type LimitKind } from "../lib/billing";
import { buildInviteLink } from "../lib/inviteLink";
import { isValidEmail, splitEmails } from "../lib/membersAccess";
import { useStore } from "../store";
import { AsyncButton } from "./AsyncButton";
import { LimitNudge } from "./LimitNudge";
import { MenuSelect } from "./MenuSelect";
import { UpgradeDialog } from "./UpgradeDialog";

type InviteAccess = TeamAccessMode | "default";

const ACCESS_OPTIONS: ReadonlyArray<{ value: InviteAccess; label: string; hint?: string }> = [
  { value: "open", label: "Can edit" },
  { value: "readonly", label: "Can view" },
  { value: "private", label: "No access" },
  { value: "default", label: "Default for new members", hint: "Whatever the New members setting says" },
];

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
export function InvitePeopleDialog({ orgId, onClose, onInvited }: {
  orgId: string;
  onClose: () => void;
  onInvited: () => void;
}) {
  const serverUrl = useStore((s) => s.serverUrl);
  const [chips, setChips] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [access, setAccess] = useState<InviteAccess>("default");
  const [code, setCode] = useState<string | null>(null);
  const [results, setResults] = useState<InviteManyResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState<{ kind: LimitKind; limit: number | null } | null>(null);
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  useEffect(() => {
    let live = true;
    authManager.api.getJoinCode().then((c) => { if (live) setCode(c); }).catch(() => {});
    return () => { live = false; };
  }, []);

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
    if (all.length === 0 || invalid.length > 0) return;
    setChips(all);
    setDraft("");
    try {
      const out = await authManager.api.inviteMany(orgId, {
        emails: all,
        role,
        access: access === "default" ? null : access,
      });
      setResults(out);
      setChips(out.filter((r) => r.error).map((r) => r.email));
      onInvited();
      void useStore.getState().refreshVault();
    } catch (e) {
      const kind = classifyLimitError(e);
      if (kind) setLimit({ kind, limit: limitFromError(e) });
      else setError(e instanceof Error ? e.message : String(e));
    }
  };

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); } catch { /* clipboard unavailable */ }
  };

  return createPortal(
    <div className="modal-backdrop" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div className="modal invite-people" role="dialog" aria-modal="true" aria-label="Invite people" onClick={(e) => e.stopPropagation()}>
        <h2 className="confirm-title">Invite people</h2>
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
              onSelect={setRole}
              ariaLabel="Role"
              triggerClassName="invite-field-trigger"
              menuClassName="access-menu"
            />
          </label>
          <label className="invite-field">
            <span className="invite-field-label">Access</span>
            <MenuSelect
              value={access}
              options={ACCESS_OPTIONS}
              onSelect={setAccess}
              ariaLabel="Access"
              triggerClassName="invite-field-trigger"
              menuClassName="access-menu"
              disabled={role === "admin"}
            />
          </label>
        </div>
        {code && (
          <div className="invite-people-code">
            <span className="muted">Or share the join code</span>
            <code className="invite-people-code-value">{code}</code>
            <button type="button" className="link-btn invite-people-copy" onClick={() => void copy(code)}>Copy</button>
          </div>
        )}
        {error && <div className="auth-error">{error}</div>}
        {limit && <LimitNudge kind={limit.kind} limit={limit.limit} onUpgrade={() => setUpgradeOpen(true)} />}
        {results?.map((r) => {
          const link = r.invitationId ? buildInviteLink(serverUrl, r.invitationId) : null;
          return (
            <div key={r.email} className={`invite-notice${r.error ? " is-warning" : ""}`}>
              {r.emailed ? (
                <span>Invitation emailed to {r.email}.</span>
              ) : !r.invitationId ? (
                <span>Couldn't invite {r.email}{r.error ? ` (${r.error})` : ""}.</span>
              ) : (
                <>
                  <span>
                    {r.error
                      ? `Invitation created, but the email to ${r.email} couldn't be sent (${r.error}). Share this link instead:`
                      : `Invitation created — this server doesn't send email, so share this link with ${r.email}:`}
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
        <div className="confirm-actions invite-people-actions">
          <button type="button" className="ghost-pill" onClick={onClose}>{results ? "Done" : "Cancel"}</button>
          <AsyncButton
            className="primary"
            spinnerTone="on-accent"
            disabled={all.length === 0 || invalid.length > 0}
            onClick={send}
          >
            {all.length >= 2 ? "Send invites" : "Send invite"}
          </AsyncButton>
        </div>
        {upgradeOpen && <UpgradeDialog onClose={() => setUpgradeOpen(false)} />}
      </div>
    </div>,
    document.body,
  );
}
