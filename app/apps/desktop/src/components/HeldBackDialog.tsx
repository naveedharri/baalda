import { useMemo, useState } from "react";
import type { HeldPerson } from "../lib/api";
import { heldPersonLine } from "../lib/groups";
import { Avatar } from "./Avatar";
import { ConfirmDialog } from "./ConfirmDialog";
import { Switch } from "./Switch";

const LEVEL_MODE: Record<HeldPerson["current"], string> = { edit: "open", view: "readonly", none: "private" };
const LEVEL: Record<HeldPerson["current"], string> = { edit: "Can edit", view: "Can view", none: "No access" };
const RANK: Record<HeldPerson["current"], number> = { none: 0, view: 1, edit: 2 };

/**
 * The people whose own setting differs from what a group gives (2026-11-28):
 * one row each (avatar, name, how many places, a Use the group's switch under
 * the column's own switch for everyone). Off = Keep their own, the default:
 * nothing is written. A row opens to every place that changes, their level
 * beside the group's, the one that will apply drawn strong. Used as step 3 of
 * New access group and by {@link HeldBackDialog} for existing groups.
 */
export function HeldChoices({ groupName, held, nameOf, imageOf, placeOf, chosen, onChosen }: {
  groupName: string;
  held: readonly HeldPerson[];
  nameOf: (userId: string) => string;
  imageOf?: (userId: string) => string | null;
  placeOf: (resourceType: string, resourceId: string) => string | null;
  chosen: ReadonlySet<string>;
  onChosen: (next: Set<string>) => void;
}) {
  const people = useMemo(() => [...new Set(held.map((h) => h.userId))], [held]);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(people.length === 1 ? people : []));
  const all = people.length > 0 && people.every((p) => chosen.has(p));
  const set = (userId: string, use: boolean) => {
    const next = new Set(chosen);
    if (use) next.add(userId); else next.delete(userId);
    onChosen(next);
  };
  const placeName = (h: HeldPerson) => h.resourceType === "vault"
    ? "Whole vault"
    : h.placeName ?? placeOf(h.resourceType, h.resourceId) ?? "An item";
  return (
    <div className="held-choices">
      {/* Everyone at once is a plain button that says what it does (2026-11-28:
          a lone switch far from its label didn't read). */}
      {people.length > 1 && (
        <div className="held-head">
          <span className="muted">{people.length} people have their own setting on some of these places.</span>
          <button type="button" className="ghost-pill held-head-all" onClick={() => onChosen(all ? new Set() : new Set(people))}>
            {all ? "Keep everyone's own" : "Use the group's for everyone"}
          </button>
        </div>
      )}
      <ul className="held-list">
        {people.map((userId) => {
          const use = chosen.has(userId);
          const isOpen = open.has(userId);
          const rows = held.filter((h) => h.userId === userId);
          const n = rows.length;
          const wide = use && rows.some((h) => h.resourceType === "vault" && h.ownAt === "here" && RANK[h.groupGives] < RANK[h.current]);
          return (
            <li key={userId} className={`held-person${isOpen ? " is-open" : ""}${use ? " is-use" : ""}`}>
              <div className="held-person-row">
                <button
                  type="button"
                  className="held-person-toggle"
                  aria-expanded={isOpen}
                  onClick={() => setOpen((prev) => { const next = new Set(prev); if (next.has(userId)) next.delete(userId); else next.add(userId); return next; })}
                >
                  <svg className="held-chevron" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  <Avatar label={nameOf(userId)} image={imageOf?.(userId) ?? null} userId={userId} />
                  <span className="held-person-names">
                    <span className="held-person-name">{nameOf(userId)}</span>
                    <small className="muted">
                      {use ? `Gets ${groupName}'s` : "Keeps their own"} on {n === 1 ? "1 place" : `${n} places`}
                    </small>
                  </span>
                </button>
                <label className="held-person-choice">
                  <span>Use the group's</span>
                  <Switch checked={use} ariaLabel={`Use ${groupName}'s for ${nameOf(userId)}`} onChange={(on) => set(userId, on)} />
                </label>
              </div>
              {isOpen && (
                <div className="held-places">
                  <div className="held-place is-head" aria-hidden="true">
                    <span>Place</span><span>Their own</span><span /><span>{groupName}</span>
                  </div>
                  {rows.map((h) => (
                    <div
                      key={`${h.resourceType}:${h.resourceId}`}
                      className="held-place"
                      title={heldPersonLine(h, groupName, h.placeName ?? placeOf(h.resourceType, h.resourceId), placeOf(h.ownPlace.resourceType, h.ownPlace.resourceId))}
                    >
                      <span className="held-place-name">{placeName(h)}</span>
                      <span className={`held-pill${use ? " is-dim" : ""}`} data-mode={LEVEL_MODE[h.current]}>{LEVEL[h.current]}</span>
                      <span className="held-arrow" aria-hidden="true">→</span>
                      <span className={`held-pill${use ? "" : " is-dim"}`} data-mode={LEVEL_MODE[h.groupGives]}>{LEVEL[h.groupGives]}</span>
                    </div>
                  ))}
                  {wide && <small className="held-wide">Their own whole-vault level is removed; they get only what their groups give.</small>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * "Ask first" for a change to an existing group (Folder and Access,
 * 2026-11-27): only the owner or admin making the change answers; nobody
 * else is asked. Cancel drops the whole change.
 */
export function HeldBackDialog({ groupName, held, nameOf, imageOf, placeOf, action, onCancel, onApply }: {
  groupName: string;
  held: readonly HeldPerson[];
  nameOf: (userId: string) => string;
  imageOf?: (userId: string) => string | null;
  placeOf: (resourceType: string, resourceId: string) => string | null;
  /** The confirm button ("Save change", "Add 3 people"). */
  action: string;
  onCancel: () => void;
  /** The held entries whose person was switched to Use the group's. */
  onApply: (useGroups: HeldPerson[]) => Promise<void>;
}) {
  const people = useMemo(() => [...new Set(held.map((h) => h.userId))], [held]);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());
  return (
    <ConfirmDialog
      title={people.length === 1 ? `${nameOf(people[0]!)} has their own setting here` : `${people.length} people have their own setting here`}
      confirmLabel={action}
      tone="accent"
      onCancel={onCancel}
      onConfirm={() => onApply(held.filter((h) => chosen.has(h.userId)))}
    >
      <p className="held-intro">Keep theirs, or use the group's?</p>
      <HeldChoices groupName={groupName} held={held} nameOf={nameOf} imageOf={imageOf} placeOf={placeOf} chosen={chosen} onChosen={setChosen} />
    </ConfirmDialog>
  );
}
