/* Vault Settings → Health — "Needs attention".
   The reason the page exists. A row here is not a status line: it is the whole
   argument for one note, and every row must be able to answer "why is this not
   synced?" without a console, a log file or a support thread.

   Each row is ONE line: badge, title, the path with a few words of cause, the
   action most likely to fix it, and Ignore. The full reasoning (what it means,
   what Baalda does next, where the content is, the raw facts) is not painted;
   Copy details puts it on the clipboard, and the full sentence is the row's
   tooltip. None of it is computed here: `lib/health/model.ts` reasoned about
   it, so the screen and the clipboard can never disagree. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { HealthIssue, HealthIssueKind, HealthRemedy } from "../lib/health/types";
import { issueGroupTitle, issueRowSentence } from "../lib/health/attention";
import { toast } from "../lib/toast";
import { AsyncButton } from "./AsyncButton";
import { Spinner } from "./Spinner";
import { Glyph, PathText, type HealthHandlers } from "./HealthShared";

const NO_DISMISSED: ReadonlySet<string> = new Set();

export function HealthIssues({
  issues,
  handlers,
  syncEnabled,
  focusKey,
  dismissed = NO_DISMISSED,
  onDismiss,
  onRestore,
  before,
  hasOtherItems = false,
}: {
  /** Groups rendered first in the SAME list (the inventory differences), so
   *  Needs attention is one continuous list of one kind of group. */
  before?: ReactNode;
  /** `before` lists something, so the all-clear card must not show. */
  hasOtherItems?: boolean;
  issues: HealthIssue[];
  handlers: HealthHandlers;
  /** A local vault has no server to be behind, so its empty state says so. */
  syncEnabled: boolean;
  /** Set by the inspector's "See its entry above": expand and scroll to it. */
  focusKey?: string | null;
  /** Rows the reader has hidden (per vault, this device). They leave the list
   *  and the counts and wait in a "Dismissed" drawer at the bottom. */
  dismissed?: ReadonlySet<string>;
  onDismiss?: (key: string) => void;
  onRestore?: (key: string) => void;
}) {
  const [pageSize, setPageSize] = useState(100);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [bulk, setBulk] = useState<{ verb: string; done: number; total: number } | null>(null);
  const rows = useRef(new Map<string, HTMLLIElement>());

  // Everything below counts and lists `live`; a dismissed row is out of the
  // page's arithmetic, not merely hidden at the end of it.
  const live = useMemo(() => issues.filter((i) => !dismissed.has(i.key)), [issues, dismissed]);
  const hidden = useMemo(() => issues.filter((i) => dismissed.has(i.key)), [issues, dismissed]);

  // Every live row, paged below; groups replaced the chips and the search box.
  const matching = live;

  const shown = useMemo(() => {
    const page = matching.slice(0, pageSize);
    const focused = focusKey ? matching.find((i) => i.key === focusKey) : undefined;
    if (focused && !page.includes(focused)) page.push(focused);
    return page;
  }, [matching, pageSize, focusKey]);

  // A focus request from the inspector brings the row into view.
  // Deliberately keyed on the request rather than on the row: asking for the
  // same row twice should scroll to it again.
  useEffect(() => {
    if (!focusKey) return;
    const el = rows.current.get(focusKey);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusKey]);

  // A row paged out of view must not stay queued for a bulk
  // action the reader can no longer see.
  const visibleKeys = useMemo(() => new Set(shown.map((i) => i.key)), [shown]);
  const picked = useMemo(
    () => shown.filter((i) => selected.has(i.key)),
    [shown, selected],
  );
  const leftBehindPaths = useMemo(
    () =>
      live
        .filter((i) => i.kind === "left-behind" && i.path != null && i.path !== "")
        .map((i) => i.path as string),
    [live],
  );
  const retryable = picked.filter((i) => i.remedies.includes("retry") && i.docId);
  const deletable = picked.filter((i) => i.remedies.includes("delete") && i.path);

  if (live.length === 0) {
    return (
      <div className="health-attention-list">
        {before}
        <LeftBehindErrors handlers={handlers} standalone />
        {!hasOtherItems && <div className="health-allclear">
          <span className="health-allclear-badge" aria-hidden="true">
            <Glyph name="check" size={18} />
          </span>
          <div>
            <strong>Nothing needs attention</strong>
            <p className="muted">
              {hidden.length > 0
                ? `${hidden.length} ${hidden.length === 1 ? "row is" : "rows are"} dismissed below.`
                : syncEnabled
                  ? "No sync errors reported."
                  : "Sync is off, so there is nothing to report here."}
            </p>
          </div>
        </div>}
        {hidden.length > 0 && <DismissedIssues rows={hidden} onRestore={onRestore} />}
      </div>
    );
  }

  const toggle = (key: string, set: ReadonlySet<string>, apply: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    apply(next);
  };

  const runBulk = async (
    verb: string,
    list: HealthIssue[],
    run: (issue: HealthIssue) => Promise<unknown>,
  ) => {
    let done = 0;
    let failed = 0;
    setBulk({ verb, done, total: list.length });
    for (const issue of list) {
      try {
        await run(issue);
      } catch {
        failed++;
      }
      done++;
      setBulk({ verb, done, total: list.length });
    }
    setBulk(null);
    setSelected(new Set());
    toast(
      failed === 0
        ? `${verb} ${done} ${done === 1 ? "note" : "notes"}`
        : `${verb} ${done - failed} of ${done}; ${failed} failed`,
    );
  };

  return (
    <div className="health-attention-list">
      {before}
      {(picked.length > 0 || bulk) && (
        <div className="health-bulkbar" role="group" aria-label="Actions for selected issues">
          <span className="health-bulk-count">
            {bulk
              ? `${bulk.verb} ${bulk.done} of ${bulk.total}…`
              : `${picked.length} selected`}
          </span>
          {!bulk && retryable.length > 0 && (
            <AsyncButton
              className="ghost-pill sm"
              onClick={() =>
                runBulk("Retried", retryable, (i) =>
                  handlers.actions.retryDoc(i.docId as string),
                )
              }
            >
              Retry selected
            </AsyncButton>
          )}
          {!bulk && deletable.length > 0 && (
            <button
              type="button"
              className="link-btn danger"
              onClick={() =>
                handlers.confirm({ kind: "delete", path: deletable[0].path as string })
              }
              title={
                deletable.length > 1
                  ? "Deleting more than one at a time is not offered here — delete them one by one so each confirm names the note"
                  : undefined
              }
              disabled={deletable.length > 1}
            >
              Delete selected
            </button>
          )}
          {!bulk && onDismiss && (
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                for (const i of picked) onDismiss(i.key);
                setSelected(new Set());
              }}
            >
              Ignore selected
            </button>
          )}
          {!bulk && (
            <button type="button" className="link-btn" onClick={() => setSelected(new Set())}>
              Clear
            </button>
          )}
        </div>
      )}

      {shown.length > 1 && (
        <label className="health-selectall">
          <input
            type="checkbox"
            checked={shown.every((i) => selected.has(i.key))}
            onChange={(e) =>
              setSelected(
                e.target.checked
                  ? new Set([...selected, ...visibleKeys])
                  : new Set([...selected].filter((k) => !visibleKeys.has(k))),
              )
            }
          />
          Select all visible
        </label>
      )}

      {(
        groupByKind(shown).map(([kind, rowsOfKind]) => {
          const total = matching.filter((i) => i.kind === kind).length;
          return (
            <div className="health-difference-group health-issue-group" key={kind}>
              <div className="health-difference-grouphead">
                <h4>{issueGroupTitle(kind, total)}</h4>
                {kind === "left-behind" && (
                  <LeftBehindActions paths={leftBehindPaths} handlers={handlers} />
                )}
              </div>
              {kind === "left-behind" && <LeftBehindErrors handlers={handlers} />}
              <ul className="health-issues">
                {rowsOfKind.map((issue) => (
                  <IssueRow
                    key={issue.key}
                    issue={issue}
                    handlers={handlers}
                    selected={selected.has(issue.key)}
                    onSelect={() => toggle(issue.key, selected, setSelected)}
                    register={(el) => {
                      if (el) rows.current.set(issue.key, el);
                      else rows.current.delete(issue.key);
                    }}
                    onDismiss={onDismiss ? () => onDismiss(issue.key) : undefined}
                  />
                ))}
              </ul>
            </div>
          );
        })
      )}
      {leftBehindPaths.length === 0 && <LeftBehindErrors handlers={handlers} standalone />}
      {shown.length < matching.length && (
        <button type="button" onClick={() => setPageSize((size) => size + 100)}>
          {`Show more (${matching.length - shown.length} remaining)`}
        </button>
      )}
      {hidden.length > 0 && <DismissedIssues rows={hidden} onRestore={onRestore} />}
    </div>
  );
}

/** Issues grouped by kind, in the order each kind first appears. */
function groupByKind(issues: HealthIssue[]): Array<[HealthIssueKind, HealthIssue[]]> {
  const groups = new Map<HealthIssueKind, HealthIssue[]>();
  for (const i of issues) {
    const g = groups.get(i.kind);
    if (g) g.push(i);
    else groups.set(i.kind, [i]);
  }
  return [...groups.entries()];
}

/** The Left-on-disk group's header actions: re-register or delete every file
 *  the Remote Vault dropped before this device confirmed it. Each item goes
 *  through the same action its own row button runs; deleting asks first (the
 *  page raises that confirm), because these may be the only copies. Progress
 *  is the pressed button's own spinner — never a status line in the list. */
function LeftBehindActions({
  paths,
  handlers,
}: {
  paths: string[];
  handlers: HealthHandlers;
}) {
  const group = handlers.leftBehind;
  if (!group || paths.length === 0) return null;
  const running = group.run?.running ? group.run.verb : null;
  return (
    <span className="health-group-actions" role="group" aria-label="Left on disk">
      <AsyncButton
        className="ghost-pill sm"
        disabled={running != null}
        onClick={() => group.start("reregister", paths)}
      >
        Re-register all
      </AsyncButton>
      <button
        type="button"
        className={`ghost-pill sm danger${running === "delete" ? " is-busy" : ""}`}
        disabled={running != null}
        aria-busy={running === "delete" || undefined}
        onClick={() => handlers.confirm({ kind: "delete-left-behind", paths })}
      >
        <span className="async-btn-label">Delete all local copies</span>
        {running === "delete" && <Spinner size="xs" tone="inherit" />}
      </button>
    </span>
  );
}

/** What a finished bulk run could not do, by path. Success is a toast; only
 *  failures earn space in the list. `standalone` wraps them in their own group
 *  for when every row resolved and the Left-on-disk group is gone. */
function LeftBehindErrors({
  handlers,
  standalone = false,
}: {
  handlers: HealthHandlers;
  standalone?: boolean;
}) {
  const run = handlers.leftBehind?.run;
  if (!run || run.running || run.failed.length === 0) return null;
  const verbed = run.verb === "delete" ? "Deleted" : "Re-registered";
  const list = (
    <ul className="health-group-errors" role="alert">
      <li className="health-group-status">
        {`${verbed} ${(run.done - run.failed.length).toLocaleString()} of ${run.done.toLocaleString()}; ${run.failed.length.toLocaleString()} failed`}
      </li>
      {run.failed.slice(0, 20).map((f) => (
        <li key={f.path}>
          <PathText path={f.path} />
          <small>{f.reason}</small>
        </li>
      ))}
      {run.failed.length > 20 && (
        <li className="muted">And {(run.failed.length - 20).toLocaleString()} more.</li>
      )}
    </ul>
  );
  return standalone ? (
    <div className="health-difference-group health-issue-group">
      <div className="health-difference-grouphead"><h4>Left on disk</h4></div>
      {list}
    </div>
  ) : list;
}

/** Where dismissed rows wait. One quiet line until opened; each row has its
 *  way back, because "I know" today is not "never tell me" forever. */
function DismissedIssues({
  rows,
  onRestore,
}: {
  rows: HealthIssue[];
  onRestore?: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="health-ignored">
      <button
        type="button"
        className="health-ignored-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="health-chevron" data-open={open ? "" : undefined} aria-hidden="true">
          <Glyph name="chevron" />
        </span>
        Ignored · {rows.length}
      </button>
      {open && (
        <ul className="health-ignored-list">
          {rows.map((i) => (
            <li key={i.key}>
              <span className="health-ignored-label">{i.title}</span>
              {i.path && <PathText path={i.path} />}
              {onRestore && (
                <button type="button" className="link-btn" onClick={() => onRestore(i.key)}>
                  Show again
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── One row ───────────────────────────────────────────────────────────────────

/** Remedies worth a button on the one-line row. Everything the old expanded
 *  panel explained is still on the clipboard through Copy details. */
const ROW_ACTIONS: ReadonlySet<HealthRemedy> = new Set<HealthRemedy>([
  "retry",
  "open",
  "reregister",
  "upgrade",
  "sign-in",
  "reset-history",
  "reclaim",
  "contact-owner",
]);

function IssueRow({
  issue,
  handlers,
  selected,
  onSelect,
  register,
  onDismiss,
}: {
  issue: HealthIssue;
  handlers: HealthHandlers;
  selected: boolean;
  onSelect: () => void;
  register: (el: HTMLLIElement | null) => void;
  /** Hide this row (per vault, this device). Absent ⇒ no button. */
  onDismiss?: () => void;
}) {
  // The first remedy the issue can act on, plus a Re-register or Open beside
  // it when the issue offers one — at most two buttons on the line.
  const usable = issue.remedies.filter((r) => hasData(issue, r));
  const primary = usable[0] ?? null;
  const second = usable.find(
    (r) => r !== primary && ROW_ACTIONS.has(r) && (r === "reregister" || r === "retry"),
  );
  const actions = [primary, second].filter(
    (r): r is HealthRemedy => r != null && r !== "copy-details",
  );
  const canCopy = usable.includes("copy-details");

  return (
    <li
      className="health-issue"
      data-severity={issue.severity}
      data-tone={issue.severity === "error" ? "bad" : "warn"}
      ref={register}
    >
      <div className="health-issue-head">
        <input
          type="checkbox"
          className="health-issue-check"
          checked={selected}
          onChange={onSelect}
          aria-label={`Select ${issue.title}${issue.path ? ` — ${issue.path}` : ""}`}
        />
        <span className="health-issue-summary" title={issue.why}>
          <span
            className="health-issue-badge"
            aria-label={issue.severity === "error" ? "Error" : "Warning"}
          >
            <Glyph name="alert" size={13} />
          </span>
          {/* The group header names the kind; the row is just WHICH one. A
              row with no path says one short sentence instead. */}
          <span className="health-issue-main health-issue-oneline">
            {issue.path ? (
              <span className="health-issue-meta"><PathText path={issue.path} /></span>
            ) : (
              <span className="health-issue-sentence">{issueRowSentence(issue)}</span>
            )}
          </span>
        </span>
        <div className="health-issue-primary">
          {actions.map((r) => (
            <Remedy key={r} remedy={r} issue={issue} handlers={handlers} emphasis />
          ))}
          {canCopy && <Remedy remedy="copy-details" issue={issue} handlers={handlers} />}
        </div>
        {onDismiss && (
          <button
            type="button"
            className="link-btn health-issue-dismiss"
            title="Hide this row for this vault on this device — it waits in the Ignored list"
            onClick={onDismiss}
          >
            Ignore
          </button>
        )}
      </div>
    </li>
  );
}

/** A remedy whose data the issue does not carry renders nothing at all, rather
 *  than a button that would throw or silently do nothing when pressed. */
function hasData(issue: HealthIssue, remedy: HealthRemedy): boolean {
  switch (remedy) {
    case "retry":
    case "reset-history":
      return issue.docId != null;
    case "open":
    case "reveal":
    case "delete":
    case "export-copy":
    case "reregister":
      return issue.path != null && issue.path !== "";
    default:
      return true;
  }
}

// ── One remedy button ─────────────────────────────────────────────────────────

function Remedy({
  remedy,
  issue,
  handlers,
  emphasis = false,
}: {
  remedy: HealthRemedy;
  issue: HealthIssue;
  handlers: HealthHandlers;
  /** The collapsed row's single button: a pill, not a text link. */
  emphasis?: boolean;
}) {
  const { actions, confirm, openNote, reclaim } = handlers;
  const [copied, setCopied] = useState(false);
  const pill = emphasis ? "ghost-pill sm" : "link-btn";

  switch (remedy) {
    case "retry":
      return (
        <AsyncButton
          className={pill}
          onClick={() => actions.retryDoc(issue.docId as string)}
        >
          Retry
        </AsyncButton>
      );
    case "open":
      return (
        <button type="button" className={pill} onClick={() => openNote(issue.path as string)}>
          Open
        </button>
      );
    case "reveal":
      return (
        <AsyncButton className={pill} onClick={() => actions.reveal(issue.path as string)}>
          Reveal
        </AsyncButton>
      );
    case "delete":
      return (
        <button
          type="button"
          className={emphasis ? "ghost-pill sm danger" : "link-btn danger"}
          onClick={() => confirm({ kind: "delete", path: issue.path as string })}
        >
          Delete
        </button>
      );
    case "upgrade":
      return (
        <button type="button" className="primary sm" onClick={() => actions.openUpgrade()}>
          Upgrade
        </button>
      );
    case "reset-history":
      return (
        <button
          type="button"
          className={emphasis ? "ghost-pill sm" : "link-btn danger"}
          onClick={() =>
            confirm({ kind: "reset", docId: issue.docId as string, path: issue.path })
          }
        >
          Reset history
        </button>
      );
    case "reclaim":
      return (
        <AsyncButton className={emphasis ? "ghost-pill sm" : "link-btn"} onClick={reclaim}>
          Reclaim
        </AsyncButton>
      );
    case "sign-in":
      return (
        <button type="button" className="primary sm" onClick={() => actions.requestSignIn()}>
          Sign in
        </button>
      );
    case "export-copy":
      return (
        <AsyncButton
          className={pill}
          onClick={() => actions.exportCopy(issue.path as string)}
        >
          Save a copy
        </AsyncButton>
      );
    case "copy-details":
      return (
        <AsyncButton
          className={pill}
          onClick={async () => {
            await actions.copyIssue(issue);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied ✓" : "Copy details"}
        </AsyncButton>
      );
    case "reregister":
      return (
        <button
          type="button"
          className={pill}
          onClick={() => confirm({ kind: "reregister", path: issue.path as string })}
        >
          Re-register
        </button>
      );
    case "contact-owner":
      // Feedback is a toast, never a card inside the one-line row.
      return (
        <AsyncButton
          className={pill}
          onClick={async () => {
            const out = await actions.contactOwner();
            toast(
              out.owner
                ? `Request copied — send it to ${out.owner.name} (${out.owner.email})`
                : "Request copied to clipboard. This vault's owner is not known on this device yet.",
            );
          }}
        >
          Contact the owner
        </AsyncButton>
      );
    default:
      return null;
  }
}
