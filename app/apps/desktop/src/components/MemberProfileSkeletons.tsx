// SPDX-License-Identifier: Apache-2.0
// The `.skel-line` shimmer lives with the editor skeleton (as MembersAccessTab does).
import "./editor.css";

/** Header (avatar + name + email) and the six Personal info rows. */
export function ProfileSkeleton() {
  return (
    <section className="member-profile member-profile-skeleton" role="status" aria-busy="true" aria-label="Loading profile">
      <header className="member-profile-head" aria-hidden="true">
        <span className="skel-line member-skel-avatar" />
        <span className="members-skel-names">
          <span className="skel-line members-skel-name" />
          <span className="skel-line members-skel-email" />
        </span>
      </header>
      <InfoSkeleton />
    </section>
  );
}

const INFO_LABELS = ["Name", "Email", "Role", "Joined", "Last active", "Status"] as const;
const INFO_WIDTHS = [120, 160, 72, 180, 120, 56];

/** Personal info: the real labels, a bar where each value goes. */
export function InfoSkeleton() {
  return (
    <dl className="member-profile-about" aria-hidden="true">
      {INFO_LABELS.map((label, i) => (
        <InfoRow key={label} label={label} width={INFO_WIDTHS[i]} />
      ))}
    </dl>
  );
}

function InfoRow({ label, width }: { label: string; width: number }) {
  return (
    <>
      <dt>{label}</dt>
      <dd><span className="skel-line member-skel-value" style={{ width }} /></dd>
    </>
  );
}

const BOARD_TITLES = ["Can edit", "Can view", "No access"] as const;
const BOARD_ROWS = [5, 4, 6];

/** The board's three columns, each with a header and a few row bars. */
export function BoardSkeleton() {
  return (
    <div className="access-board-columns member-skel-board" role="status" aria-busy="true" aria-label="Loading access">
      {BOARD_TITLES.map((title, c) => (
        <section key={title} className="access-board-column" aria-hidden="true">
          <header className="access-board-column-head">
            <span className="access-board-column-title">{title}</span>
          </header>
          <ul className="access-board-list">
            {Array.from({ length: BOARD_ROWS[c] }, (_, i) => (
              <li key={i} className="member-skel-board-row">
                <span className="skel-line member-skel-icon" />
                <span className="skel-line member-skel-board-name" style={{ width: `${55 + ((i * 17 + c * 11) % 35)}%` }} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** The List view's checkbox tree. */
export function TreeSkeleton() {
  return (
    <ul className="member-access-tree member-skel-tree" role="status" aria-busy="true" aria-label="Loading access">
      {Array.from({ length: 6 }, (_, i) => (
        <li key={i} className="member-access-row" aria-hidden="true" style={{ paddingLeft: `${8 + (i % 3 === 2 ? 16 : 0)}px` }}>
          <span className="member-access-main">
            <span className="member-access-twisty" />
            <span className="skel-line member-skel-check" />
            <span className="skel-line member-skel-icon" />
            <span className="skel-line member-skel-tree-name" style={{ width: 100 + ((i * 37) % 90) }} />
          </span>
          <span className="member-access-level">
            <span className="skel-line member-skel-level" />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A per-row placeholder while one tree row's level is first being read. */
export function RowLevelSkeleton() {
  return <span className="skel-line member-skel-level" role="status" aria-busy="true" aria-label="Loading" />;
}

/** Activity: a day pill and seven event rows. */
export function ActivitySkeleton() {
  return (
    <div className="member-activity member-skel-activity" role="status" aria-busy="true" aria-label="Loading activity">
      <ol className="member-activity-trail" aria-hidden="true">
        <li className="member-activity-day"><span className="skel-line member-skel-day" /></li>
        {Array.from({ length: 7 }, (_, i) => (
          <li key={i} className="member-activity-entry">
            <span className="skel-line member-skel-node" />
            <span className="member-skel-activity-body">
              <span className="skel-line member-skel-activity-line" style={{ width: `${45 + ((i * 23) % 40)}%` }} />
              <span className="skel-line member-skel-activity-time" />
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Under a loaded board, while some rows' levels are still being read. */
export function BoardPendingRows() {
  return (
    <ul className="access-board-list member-skel-pending" role="status" aria-busy="true" aria-label="Loading access">
      {[70, 52].map((w) => (
        <li key={w} className="member-skel-board-row" aria-hidden="true">
          <span className="skel-line member-skel-icon" />
          <span className="skel-line member-skel-board-name" style={{ width: `${w}%` }} />
        </li>
      ))}
    </ul>
  );
}
