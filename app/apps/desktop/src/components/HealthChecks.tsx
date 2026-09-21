/* Vault Settings → Health — the integrity checks.
   Fifteen questions Rust asks about the files on disk and the rows in the local
   index. The wording of every one of them lives in `lib/health/checks.ts`; this
   file only decides what a passing row looks like versus a failing one.

   The two rows are deliberately unequal. A PASSING row is a tick and a label,
   nothing else — its `looksFor` moves to the label's tooltip, because fifteen
   explanatory sentences stacked up is what made this section unreadable. A
   FAILING row is loud: a filled badge in the severity colour, the count as a
   filled pill beside the label, and ONE line of cause. Everything else waits
   behind the chevron.

   A passing row still exists, though, and that is the point of listing all
   fifteen: "no case collisions" is information, and a page that hides its
   passes cannot be trusted to have run them. */
import { useEffect, useRef, useState } from "react";
import {
  CHECK_GROUP_LABELS,
  checkRows,
  type CheckAction,
  type CheckRow,
} from "../lib/health/checks";
import {
  checkActionPlans,
  outcomeSummary,
  type CheckActionPlan,
} from "../lib/health/checkActions";
import type { VaultCheckId, VaultCheckItem, VaultChecks } from "../lib/health/types";
import { formatBytes } from "../lib/health/format";
import { AsyncButton } from "./AsyncButton";
import {
  Eyebrow,
  Glyph,
  PathText,
  type CheckRun,
  type HealthHandlers,
} from "./HealthShared";

/**
 * The lead sentence of a check's `whyItMatters`, for the collapsed row. The
 * rest is not lost — the expanded panel prints the whole thing — but a list of
 * fifteen rows cannot carry fifteen paragraphs and still be scannable.
 */
export function firstSentence(text: string): string {
  const t = text.trim();
  const m = /^(.*?[.!?])(?:\s|$)/.exec(t);
  return m ? m[1] : t;
}

/** A request to open one check and scroll to it. `n` changes per request, so
 *  asking for the same check twice scrolls twice. */
export interface CheckFocus {
  id: VaultCheckId;
  n: number;
}

const NO_IGNORES: ReadonlySet<VaultCheckId> = new Set();

export function HealthChecks({
  checks,
  loading,
  handlers,
  ignored = NO_IGNORES,
  onIgnore,
  onRestore,
  focus = null,
  onlyIds,
}: {
  checks: VaultChecks | null;
  loading: boolean;
  handlers: HealthHandlers;
  /** Checks the reader has chosen to live with (per vault, this device). They
   *  leave the groups and the headline and wait in an "Ignored" drawer. */
  ignored?: ReadonlySet<VaultCheckId>;
  onIgnore?: (id: VaultCheckId) => void;
  onRestore?: (id: VaultCheckId) => void;
  /** From a metric flag ("1 broken"): open that check and bring it into view. */
  focus?: CheckFocus | null;
  onlyIds?: readonly string[];
}) {
  if (checks == null) {
    if (loading) {
      return (
        <ul className="health-checks" aria-busy="true">
          {Array.from({ length: 6 }, (_, i) => (
            <li key={i} className="health-check is-skeleton" aria-hidden="true">
              <span className="health-check-glyph" />
              <span className="health-check-label" />
            </li>
          ))}
        </ul>
      );
    }
    return <p className="muted">Checks are not available for this vault.</p>;
  }

  const allRows = checkRows(checks).filter(row => !onlyIds || onlyIds.includes(row.def.id));
  // An ignored check that currently FAILS steps out of the groups and out of the
  // headline — that is what ignoring means. One that passes is shown normally;
  // there is nothing to ignore, and its tick is still information.
  const ignoredRows = allRows.filter((r) => !r.passed && ignored.has(r.def.id));
  const rows = allRows.filter((r) => r.passed || !ignored.has(r.def.id));
  // Rust sends all fifteen ids in union order, count 0 when a check passes, so
  // this set is normally complete. It is tracked anyway: an OLDER core sends
  // fewer, and `checkRows` fills the gap with a zero result. A zero Rust never
  // measured is not a pass, so those rows read "Not run" in grey instead of
  // green — the one thing this section must never do is claim a check it did
  // not run.
  const reported = new Set(checks.results.map((r) => r.id));
  const groups = (["files", "names", "links", "storage"] as const).map((group) => ({
    group,
    rows: rows.filter((r) => r.def.group === group),
  }));

  return (
    <>
      {groups.map(({ group, rows: inGroup }) =>
        inGroup.length === 0 ? null : (
          <div className="health-check-group" key={group}>
            <Eyebrow>{CHECK_GROUP_LABELS[group]}</Eyebrow>
            <ul className="health-checks">
              {inGroup.map((row) => (
                <CheckItem
                  key={row.def.id}
                  row={row}
                  state={
                    !reported.has(row.def.id) ? "unknown" : row.passed ? "passed" : "failed"
                  }
                  handlers={handlers}
                  onIgnore={onIgnore}
                  focus={focus?.id === row.def.id ? focus : null}
                />
              ))}
            </ul>
          </div>
        ),
      )}
      {ignoredRows.length > 0 && <IgnoredChecks rows={ignoredRows} onRestore={onRestore} />}
    </>
  );
}

/** The drawer an ignored check waits in. Collapsed to one line by default —
 *  the reader asked not to see these — but never gone: "Ignored · 2" is the
 *  honest summary, and each row has its way back. */
function IgnoredChecks({
  rows,
  onRestore,
}: {
  rows: CheckRow[];
  onRestore?: (id: VaultCheckId) => void;
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
          {rows.map((r) => (
            <li key={r.def.id}>
              <span className="health-ignored-label">{r.def.label}</span>
              <span className="health-ignored-count">{r.result.count.toLocaleString()}</span>
              {onRestore && (
                <button type="button" className="link-btn" onClick={() => onRestore(r.def.id)}>
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

/** What a row is actually saying. `unknown` exists so a check that never ran
 *  cannot be read as one that passed. */
type CheckState = "passed" | "failed" | "unknown";

/** A failing check takes its definition's severity; a passing one is always
 *  green, whatever it would have been; one that did not run has no colour at
 *  all, because it has no finding. */
function tone(def: CheckRow["def"], state: CheckState): "good" | "warn" | "bad" | "muted" {
  if (state === "unknown") return "muted";
  if (state === "passed") return "good";
  // Anything that fails is amber unless it is an error; a grey dot on a failing
  // row read as "nothing to see here", which is the opposite of a finding.
  return def.severity === "error" ? "bad" : "warn";
}

function CheckItem({
  row,
  state,
  handlers,
  onIgnore,
  focus,
}: {
  row: CheckRow;
  state: CheckState;
  handlers: HealthHandlers;
  onIgnore?: (id: VaultCheckId) => void;
  focus: CheckFocus | null;
}) {
  // Seeded from `focus` so a row asked for at mount is open in the first
  // render (the page is tested with static markup, where effects never run).
  const [open, setOpen] = useState(focus != null);
  const li = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (!focus) return;
    setOpen(true);
    li.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focus?.n]);
  const { def, result } = row;
  const panelId = `health-check-${def.id}`;
  const failed = state === "failed";
  // `trash` counts FILES while each item is one timestamped recovery folder, so
  // "and 387 more" under 25 rows would be wrong in both directions. Every other
  // check counts the things it lists.
  const isTrash = def.id === "trash";
  const more = isTrash ? 0 : Math.max(0, result.count - result.items.length);
  const run = handlers.checkRuns[def.id] ?? null;

  return (
    <li
      ref={li}
      className="health-check"
      data-tone={tone(def, state)}
      data-state={state}
      data-passed={state === "passed" ? "" : undefined}
      data-open={failed && open ? "" : undefined}
    >
      <div className="health-check-head">
        <button
          type="button"
          className="health-check-summary"
          aria-expanded={open}
          aria-controls={panelId}
          disabled={!failed}
          onClick={() => setOpen((v) => !v)}
        >
          <CheckBadge def={def} state={state} />
          {/* The label carries what the check looks for as its tooltip, so a
              passing row is two words instead of a sentence. */}
          <span className="health-check-label" title={def.looksFor}>
            {def.label}
          </span>
          {failed && (
            <>
              <span className="health-check-count">
                {result.count.toLocaleString()}
                {def.showsBytes && result.bytes != null && result.bytes > 0 && (
                  <span className="health-check-bytes">{formatBytes(result.bytes)}</span>
                )}
              </span>
              {/* The panel opens with the full paragraph, so the one-line
                  brief steps aside instead of repeating its first sentence. */}
              {!open && (
                <span className="health-check-why-line">
                  {firstSentence(def.whyItMatters)}
                </span>
              )}
              <span className="health-chevron" data-open={open ? "" : undefined} aria-hidden="true">
                <Glyph name="chevron" />
              </span>
            </>
          )}
          {state === "unknown" && <span className="health-check-note">Not run</span>}
        </button>
        {failed && <CheckActions row={row} handlers={handlers} />}
        {failed && onIgnore && (
          <button
            type="button"
            className="link-btn health-check-ignore"
            title="Stop showing this check for this vault on this device — it waits in the Ignored list"
            onClick={() => onIgnore(def.id)}
          >
            Ignore
          </button>
        )}
      </div>

      {/* Shown on a PASSING row too, once a run has happened: healing a check
          makes its row go green, and "Reclaimed 18 · 3.4 MB freed" vanishing at
          the same moment is the one report the reader was waiting for. */}
      {run && <CheckRunLine run={run} />}

      {failed && open && (
        <div className="health-check-panel" id={panelId}>
          <p className="health-check-why">{def.whyItMatters}</p>
          <Eyebrow>What to do</Eyebrow>
          <ol className="health-fixes">
            {def.howToFix.map((fix, i) => (
              <li key={i}>{fix}</li>
            ))}
          </ol>
          {isTrash && (
            <p className="muted">
              {result.count.toLocaleString()} {result.count === 1 ? "file" : "files"} in{" "}
              {result.items.length.toLocaleString()}
              {result.items.length >= 25 ? " or more" : ""}{" "}
              {result.items.length === 1 ? "recovery set" : "recovery sets"}.
            </p>
          )}
          {result.items.length > 0 && (
            <ul className="health-check-items">
              {result.items.map((item, i) => (
                <li key={`${item.path}-${i}`}>
                  <PathText path={item.path} />
                  {item.detail && <span className="health-check-detail">{item.detail}</span>}
                  {item.bytes != null && item.bytes > 0 && (
                    <span className="health-check-detail">{formatBytes(item.bytes)}</span>
                  )}
                  <span className="health-check-item-actions">
                    {def.itemActions.map((a) => (
                      <ItemAction key={a} action={a} item={item} handlers={handlers} />
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {more > 0 && <p className="muted">and {more.toLocaleString()} more</p>}
        </div>
      )}
    </li>
  );
}

/**
 * The mark at the head of the row, and the loudest thing in this section.
 *
 * A failing check has to READ as a warning from across the page: a filled badge
 * in the severity colour. Housekeeping gets a filled dot rather than a triangle
 * — it is a fact, not a fault — and a passing check gets a bare green tick that
 * takes up almost no attention at all.
 */
function CheckBadge({ def, state }: { def: CheckRow["def"]; state: CheckState }) {
  if (state === "passed") {
    return (
      <span className="health-check-tick" aria-label="Passed">
        <Glyph name="check" size={14} />
      </span>
    );
  }
  if (state === "unknown") {
    return <span className="health-check-dot" data-hollow="" aria-label="Not run" />;
  }
  return (
    <span
      className="health-check-badge"
      aria-label={def.severity === "error" ? "Error" : "Warning"}
    >
      <Glyph name="alert" size={13} />
    </span>
  );
}

/**
 * The buttons that treat the WHOLE check: its heal first, then the bulk forms
 * of its per-item actions.
 *
 * Nothing is decided here — `checkActionPlans` reads the definition, works out
 * which listed items each action can reach and what it will say, and this only
 * paints the result. That is what keeps "Delete all" from ever appearing on a
 * check whose items it could not delete.
 */
function CheckActions({ row, handlers }: { row: CheckRow; handlers: HealthHandlers }) {
  const plans = checkActionPlans(row);
  if (plans.length === 0) return null;
  const run = handlers.checkRuns[row.def.id] ?? null;
  const busy = run?.running === true;
  return (
    <span className="health-check-bulk">
      {plans.map((plan) => (
        <button
          key={plan.action}
          type="button"
          className={
            plan.kind === "heal"
              ? "ghost-pill sm health-heal"
              : `ghost-pill sm${plan.confirm?.tone === "danger" ? " danger" : ""}`
          }
          disabled={busy}
          title={healTitle(plan)}
          onClick={() => handlers.runCheck(plan)}
        >
          {plan.kind === "heal" && <Glyph name="spark" size={13} />}
          {plan.label}
        </button>
      ))}
    </span>
  );
}

/** What the button is about to do, in the exact numbers, before it is pressed. */
function healTitle(plan: CheckActionPlan): string {
  if (plan.wholeVault) return plan.label;
  const bits = [`${plan.label}: ${plan.targets.length.toLocaleString()} listed`];
  if (plan.skipped.length > 0) bits.push(`${plan.skipped.length.toLocaleString()} left alone`);
  if (plan.unlisted > 0) {
    bits.push(`${plan.unlisted.toLocaleString()} more are not listed and stay as they are`);
  }
  return bits.join(" · ");
}

/**
 * What the action is doing, or did. It lives on the row rather than in a toast
 * because the reader is looking at the row — and because a partial result ("11
 * of 12, 1 failed") is a finding of its own, which a toast throws away.
 */
function CheckRunLine({ run }: { run: CheckRun }) {
  const { plan, outcome } = run;
  if (run.running) {
    const progress =
      run.total > 0
        ? ` ${run.done.toLocaleString()} of ${run.total.toLocaleString()}`
        : "";
    return (
      <p className="health-check-run" data-state="running" aria-live="polite">
        {plan.gerund}
        {progress}…
      </p>
    );
  }
  if (!outcome) return null;
  const bad = outcome.errors.length > 0;
  return (
    <div
      className="health-check-run"
      data-state={outcome.cancelled ? "idle" : bad ? "bad" : "good"}
      aria-live="polite"
    >
      <p className="health-check-run-line">{outcomeSummary(outcome, plan)}</p>
      {outcome.errors.length > 0 && (
        <ul className="health-check-run-errors">
          {outcome.errors.slice(0, 5).map((e, i) => (
            <li key={`${e.path}-${i}`}>
              {e.path !== "" && <PathText path={e.path} chars={40} />}
              <span className="health-check-detail">{e.reason}</span>
            </li>
          ))}
          {outcome.errors.length > 5 && (
            <li className="muted">and {(outcome.errors.length - 5).toLocaleString()} more</li>
          )}
        </ul>
      )}
      {outcome.skipped.length > 0 && (
        <ul className="health-check-run-errors">
          {outcome.skipped.slice(0, 5).map((e, i) => (
            <li key={`${e.path}-${i}`}>
              {e.path !== "" && <PathText path={e.path} chars={40} />}
              <span className="health-check-detail">{e.reason}</span>
            </li>
          ))}
          {outcome.skipped.length > 5 && (
            <li className="muted">and {(outcome.skipped.length - 5).toLocaleString()} more</li>
          )}
        </ul>
      )}
    </div>
  );
}

function ItemAction({
  action,
  item,
  handlers,
}: {
  action: CheckAction;
  item: VaultCheckItem;
  handlers: HealthHandlers;
}) {
  const { actions, confirm, openNote } = handlers;
  switch (action) {
    case "open":
      return (
        <button type="button" className="ghost-pill sm" onClick={() => openNote(item.path)}>
          Open
        </button>
      );
    case "reveal":
      return (
        <AsyncButton className="ghost-pill sm" onClick={() => actions.reveal(item.path)}>
          Reveal
        </AsyncButton>
      );
    case "delete":
      return (
        <button
          type="button"
          className="ghost-pill sm danger"
          onClick={() => confirm({ kind: "delete", path: item.path })}
        >
          Delete
        </button>
      );
    case "export-copy":
      return (
        <AsyncButton className="link-btn" onClick={() => actions.exportCopy(item.path)}>
          Save a copy
        </AsyncButton>
      );
    case "reset-history":
      // Only a doc id can be reset; a check item without one (an unindexed file)
      // has no history to discard, so the action is simply absent.
      return item.docId ? (
        <button
          type="button"
          className="ghost-pill sm danger"
          onClick={() =>
            confirm({ kind: "reset", docId: item.docId as string, path: item.path })
          }
        >
          Reset history
        </button>
      ) : null;
    default:
      return null;
  }
}
