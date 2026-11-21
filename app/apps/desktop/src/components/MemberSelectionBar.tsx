import { useRef } from "react";
import type { AccessGroup, TeamAccessMode } from "../lib/api";
import { PERSON_LEVEL_LABEL } from "../lib/membersAccess";
import { MenuSelect } from "./MenuSelect";

/**
 * Shown in the toolbar's place while people are ticked in the Members table:
 * the count, the bulk actions and a clear button. Each action only reaches the
 * ticked people this person may change; the caller reports who was skipped.
 */
export function MemberSelectionBar({ shown = true, count, groups, busy, canAccess, canRole, onAddToGroup, onAccess, onRole, onRemove, onClear }: {
  /** Fades in over the toolbar while anyone is ticked; stays mounted so it can fade out. */
  shown?: boolean;
  count: number;
  /** Access groups to offer; empty hides "Add to access group". */
  groups: readonly AccessGroup[];
  busy: boolean;
  /** Any ticked person whose access this person may change. */
  canAccess: boolean;
  /** Any ticked person whose role / membership this person may change. */
  canRole: boolean;
  onAddToGroup: (groupId: string) => void;
  onAccess: (mode: TeamAccessMode) => void;
  onRole: (role: "member" | "admin") => void;
  onRemove: () => void;
  onClear: () => void;
}) {
  // Keep the last count while fading out, so it never reads "0 selected".
  const lastCount = useRef(count);
  if (count > 0) lastCount.current = count;
  return (
    <div
      className={`members-select-bar${shown ? " is-shown" : ""}`}
      role="toolbar"
      aria-label="Selected people"
      aria-hidden={!shown}
      inert={!shown}
    >
      <span className="members-select-count"><span key={lastCount.current} className="members-select-num">{lastCount.current}</span> selected</span>
      {groups.length > 0 && (
        <MenuSelect<string>
          value=""
          options={groups.map((g) => ({ value: g.id, label: g.name }))}
          onSelect={onAddToGroup}
          disabled={busy || !canAccess}
          ariaLabel="Add the selected people to an access group"
          triggerClassName="members-select-btn"
          menuClassName="access-menu"
          triggerContent={<><GroupGlyph />Add to access group</>}
        />
      )}
      <MenuSelect<TeamAccessMode | "">
        value=""
        options={[
          { value: "open", label: PERSON_LEVEL_LABEL.edit },
          { value: "readonly", label: PERSON_LEVEL_LABEL.view },
          { value: "private", label: PERSON_LEVEL_LABEL.none },
        ]}
        onSelect={(v) => { if (v) onAccess(v); }}
        disabled={busy || !canAccess}
        ariaLabel="Change access for the selected people"
        triggerClassName="members-select-btn"
        menuClassName="access-menu"
        triggerContent={<><LockGlyph />Change access</>}
      />
      <MenuSelect<"member" | "admin" | "">
        value=""
        options={[
          { value: "member", label: "Member" },
          { value: "admin", label: "Admin" },
        ]}
        onSelect={(v) => { if (v) onRole(v); }}
        disabled={busy || !canRole}
        ariaLabel="Change role for the selected people"
        triggerClassName="members-select-btn"
        menuClassName="access-menu"
        triggerContent={<><ShieldGlyph />Change role</>}
      />
      <button type="button" className="members-select-btn is-danger" disabled={busy || !canRole} onClick={onRemove}>
        <LeaveGlyph />Remove
      </button>
      <button type="button" className="members-select-clear" aria-label="Clear selection" onClick={onClear}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </div>
  );
}

const glyph = (d: React.ReactNode) => (
  <svg className="members-select-glyph" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
const GroupGlyph = () => glyph(<><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M21.5 20a6.5 6.5 0 0 0-4-6" /></>);
const LockGlyph = () => glyph(<><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>);
const ShieldGlyph = () => glyph(<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6Z" />);
const LeaveGlyph = () => glyph(<><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" /><path d="M10 17l5-5-5-5M15 12H3" /></>);
