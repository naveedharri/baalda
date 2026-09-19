/* Vault Settings → Health — "Needs attention".
   The reason the page exists. A row here is not a status line: it is the whole
   argument for one note, and every row must be able to answer "why is this not
   synced?" without a console, a log file or a support thread.

   The collapsed row carries the one-line cause and the one action most likely
   to fix it. Everything else — what it means, what Baalda will do on its own,
   what the reader can do, where their content actually is right now, and the
   raw facts a bug report needs — is one keystroke away in the expanded panel.
   None of it is computed here: `lib/health/model.ts` already reasoned about it,
   so the screen and the clipboard can never disagree. */
import { useEffect, useMemo, useRef, useState } from "react";
import type { HealthIssue, HealthIssueKind, HealthRemedy } from "../lib/health/types";
import { safetyLabel } from "../lib/health/model";
import { kindLabel } from "../lib/health/format";
import { toast } from "../lib/toast";
import { AsyncButton } from "./AsyncButton";
import { Chip, CopyButton, Eyebrow, Glyph, PathText, type HealthHandlers } from "./HealthShared";

/** Past this many issues the list needs a text box as well as chips. */
const SEARCH_AT = 8;

type Filter = "all" | "error" | "warn" | { kind: HealthIssueKind };

function filterKey(f: Filter): string {
  return typeof f === "string" ? f : `kind:${f.kind}`;
}

function matches(issue: HealthIssue, f: Filter): boolean {
  if (f === "all") return true;
  if (f === "error" || f === "warn") return issue.severity === f;
  return issue.kind === f.kind;
}

const NO_DISMISSED: ReadonlySet<string> = new Set();

export function HealthIssues({
  issues,
  handlers,
  syncEnabled,
  focusKey,
  dismissed = NO_DISMISSED,
  onDismiss,
  onRestore,
}: {
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
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  // Seeded from `focusKey` rather than opened by the effect below, so a row
  // asked for at mount is already open in the FIRST render — an effect would
  // leave it shut under `renderToStaticMarkup`, which is how the page is tested.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set<string>(focusKey ? [focusKey] : []),
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [bulk, setBulk] = useState<{ verb: string; done: number; total: number } | null>(null);
  const rows = useRef(new Map<string, HTMLLIElement>());

  // Everything below counts and lists `live`; a dismissed row is out of the
  // page's arithmetic, not merely hidden at the end of it.
  const live = useMemo(() => issues.filter((i) => !dismissed.has(i.key)), [issues, dismissed]);
  const hidden = useMemo(() => issues.filter((i) => dismissed.has(i.key)), [issues, dismissed]);

  const errors = live.filter((i) => i.severity === "error").length;
  const kinds = useMemo(() => {
    const counts = new Map<HealthIssueKind, number>();
    for (const i of live) counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1);
    return [...counts.entries()];
  }, [live]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return live.filter((i) => {
      if (!matches(i, filter)) return false;
      if (q === "") return true;
      return (
        (i.path ?? "").toLowerCase().includes(q) || i.title.toLowerCase().includes(q)
      );
    });
  }, [live, filter, query]);

  // A focus request from the inspector opens the row and brings it into view.
  // Deliberately keyed on the request rather than on the row: asking for the
  // same row twice should scroll to it again.
  useEffect(() => {
    if (!focusKey) return;
    setExpanded((prev) => new Set(prev).add(focusKey));
    const el = rows.current.get(focusKey);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusKey]);

  // A filter that hides a selected row must not leave it queued for a bulk
  // action the reader can no longer see.
  const visibleKeys = useMemo(() => new Set(shown.map((i) => i.key)), [shown]);
  const picked = useMemo(
    () => shown.filter((i) => selected.has(i.key)),
    [shown, selected],
  );
  const retryable = picked.filter((i) => i.remedies.includes("retry") && i.docId);
  const deletable = picked.filter((i) => i.remedies.includes("delete") && i.path);

  if (live.length === 0) {
    return (
      <>
        <div className="health-allclear">
          <span className="health-allclear-badge" aria-hidden="true">
            <Glyph name="check" size={18} />
          </span>
          <div>
            <strong>Nothing needs attention</strong>
            <p className="muted">
              {hidden.length > 0
                ? `${hidden.length} ${hidden.length === 1 ? "row is" : "rows are"} dismissed below.`
                : syncEnabled
                  ? "Every note the Remote Vault knows about is confirmed."
                  : "Sync is off, so there is nothing to report here."}
            </p>
          </div>
        </div>
        {hidden.length > 0 && <DismissedIssues rows={hidden} onRestore={onRestore} />}
      </>
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
    <>
      <div className="health-issue-toolbar">
        <div className="health-chips" role="group" aria-label="Filter issues">
          <Chip active={filter === "all"} onClick={() => setFilter("all")} count={live.length}>
            All
          </Chip>
          {errors > 0 && (
            <Chip active={filter === "error"} onClick={() => setFilter("error")} count={errors}>
              Errors
            </Chip>
          )}
          {live.length - errors > 0 && (
            <Chip
              active={filter === "warn"}
              onClick={() => setFilter("warn")}
              count={live.length - errors}
            >
              Warnings
            </Chip>
          )}
          {kinds.length > 1 &&
            kinds.map(([kind, n]) => (
              <Chip
                key={kind}
                active={filterKey(filter) === `kind:${kind}`}
                onClick={() => setFilter({ kind })}
                count={n}
              >
                {kindLabel(kind)}
              </Chip>
            ))}
        </div>
        {live.length > SEARCH_AT && (
          <input
            type="search"
            className="health-search"
            placeholder="Filter by name or path…"
            aria-label="Filter issues by name or path"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
      </div>

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

      {shown.length === 0 ? (
        <p className="muted">Nothing matches this filter.</p>
      ) : (
        <ul className="health-issues">
          {shown.map((issue) => (
            <IssueRow
              key={issue.key}
              issue={issue}
              handlers={handlers}
              open={expanded.has(issue.key)}
              onToggle={() => toggle(issue.key, expanded, setExpanded)}
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
      )}
      {hidden.length > 0 && <DismissedIssues rows={hidden} onRestore={onRestore} />}
    </>
  );
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

function IssueRow({
  issue,
  handlers,
  open,
  onToggle,
  selected,
  onSelect,
  register,
  onDismiss,
}: {
  issue: HealthIssue;
  handlers: HealthHandlers;
  open: boolean;
  onToggle: () => void;
  selected: boolean;
  onSelect: () => void;
  register: (el: HTMLLIElement | null) => void;
  /** Hide this row (per vault, this device). Absent ⇒ no button. */
  onDismiss?: () => void;
}) {
  const panelId = `health-panel-${encodeURIComponent(issue.key)}`;
  const primary = issue.remedies.find((r) => hasData(issue, r)) ?? null;

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
        <button
          type="button"
          className="health-issue-summary"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onToggle}
        >
          {/* A filled badge in the severity colour, not a 8px dot: a row that
              needs a person has to read as a warning from across the page. */}
          <span
            className="health-issue-badge"
            aria-label={issue.severity === "error" ? "Error" : "Warning"}
          >
            <Glyph name="alert" size={13} />
          </span>
          <span className="health-issue-main">
            <span className="health-issue-title">{issue.title}</span>
            {issue.path && <PathText path={issue.path} />}
            {/* One line. The whole of `why` is in the panel, under the chevron. */}
            <span className="health-why">{issue.why}</span>
          </span>
          <span className="health-chevron" data-open={open ? "" : undefined} aria-hidden="true">
            <Glyph name="chevron" />
          </span>
        </button>
        {primary && (
          <div className="health-issue-primary">
            <Remedy remedy={primary} issue={issue} handlers={handlers} emphasis />
          </div>
        )}
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

      {open && (
        <div className="health-issue-panel" id={panelId}>
          <div className="health-reasoning">
            <div className="health-block">
              <Eyebrow>What this means</Eyebrow>
              <p>{issue.explanation.meaning}</p>
            </div>
            <div className="health-block">
              <Eyebrow>What Baalda does next</Eyebrow>
              <p>
                <span className="health-tag" data-auto={issue.autoRetries ? "" : undefined}>
                  {issue.autoRetries ? "Retries by itself" : "Needs you"}
                </span>
                {issue.explanation.next}
              </p>
            </div>
            <div className="health-block">
              <Eyebrow>What you can do</Eyebrow>
              <ol className="health-fixes">
                {issue.explanation.fixes.map((fix, i) => (
                  <li key={i}>{fix}</li>
                ))}
              </ol>
            </div>
          </div>

          <p className="health-safety" data-safety={issue.explanation.safety}>
            <Eyebrow>Where your content is</Eyebrow>
            <span>{safetyLabel(issue.explanation.safety)}</span>
          </p>

          {issue.facts.length > 0 && (
            <dl className="health-facts">
              {issue.facts.map((f, i) => (
                <div className="health-fact" key={`${f.label}-${i}`}>
                  <dt>{f.label}</dt>
                  <dd>
                    <span className="health-fact-value">{f.value}</span>
                    {f.copyable && <CopyButton value={f.value} label={`Copy ${f.label}`} />}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          <div className="health-remedies">
            {issue.remedies.map((r) =>
              hasData(issue, r) ? (
                <Remedy key={r} remedy={r} issue={issue} handlers={handlers} />
              ) : null,
            )}
          </div>
        </div>
      )}
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
  const [owner, setOwner] = useState<{ name: string; email: string } | null | undefined>();
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
      return (
        <>
          <AsyncButton
            className={pill}
            onClick={async () => {
              const out = await actions.contactOwner();
              setOwner(out.owner);
            }}
          >
            Contact the owner
          </AsyncButton>
          {owner !== undefined && (
            <div className="health-owner-card">
              {owner ? (
                <>
                  <strong>{owner.name}</strong>
                  <a href={`mailto:${owner.email}`}>{owner.email}</a>
                </>
              ) : (
                <strong>This vault&rsquo;s owner is not known on this device yet.</strong>
              )}
              <span className="muted">Request copied to clipboard</span>
            </div>
          )}
        </>
      );
    default:
      return null;
  }
}
