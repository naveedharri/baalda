/* Vault Settings → Health — the pieces every section of the page shares.
   Kept in one module so the five section components (issues, checks, inspector,
   timeline, stats) cannot each grow their own section header, their own path
   cell or their own copy button. Nothing here knows about the report: it is
   presentation only, so a section can be read on its own. */
import { useState, type ReactNode } from "react";
import { copyText } from "../lib/clipboard";
import { middleTruncate } from "../lib/health/format";
import type {
  CheckActionOutcome,
  CheckActionPlan,
} from "../lib/health/checkActions";
import type { HealthActions, VaultCheckId } from "../lib/health/types";

/** Characters of a path that fit on one row before the middle is elided. */
export const PATH_CHARS = 52;

/** The confirms the page can raise. All of them live at the top of the page
 *  rather than inside a row, so a row unmounting mid-confirm (a refresh
 *  landing, a filter changing) cannot take the dialog with it. */
export type ConfirmState =
  | { kind: "delete"; path: string }
  | { kind: "reset"; docId: string; path: string | null }
  | { kind: "reregister"; path: string }
  /** "Delete all local copies" on the Left-on-disk group: names the count,
   *  because these files may be the only copies there are. */
  | { kind: "delete-left-behind"; paths: string[] }
  | { kind: "empty-trash" }
  | { kind: "rebuild-index" }
  /** A check's heal or bulk action that asked to be confirmed. The plan carries
   *  its own wording (from `checks.ts`) and the exact number it will touch. */
  | { kind: "check-action"; plan: CheckActionPlan };

/** Everything a section needs to act. One object, so adding a remedy is one
 *  field rather than five prop lists. */
export interface HealthHandlers {
  actions: HealthActions;
  /** Open a note AND close settings — the note is behind this card. */
  openNote: (path: string) => void;
  /** Raise one of the confirms above. */
  confirm: (c: ConfirmState) => void;
  /** Reclaim orphan history and toast the result. */
  reclaim: () => Promise<void>;
  /** Start a check's heal or bulk action, confirming first when its plan says
   *  to. The page owns the run so a collapsing row cannot abandon it. */
  runCheck: (plan: CheckActionPlan) => void;
  /** What each check's action is doing, or last did. Keyed by check id and kept
   *  on the page, not in the row, for the same reason. */
  checkRuns: Partial<Record<VaultCheckId, CheckRun>>;
  /** The Left-on-disk group's bulk run ("Re-register all" / "Delete all local
   *  copies"). Owned by the page like `checkRuns`, so the group emptying as its
   *  rows resolve cannot drop the result. Absent ⇒ no bulk actions offered. */
  leftBehind?: {
    run: LeftBehindRun | null;
    /** Resolves when the run ends, so the pressed button can carry the spinner. */
    start: (verb: "reregister" | "delete", paths: string[]) => Promise<void>;
  };
  /** A slowly-ticking clock, so relative times do not go stale in an open
   *  dialog and every section agrees on "now". */
  now: number;
}

/** The Left-on-disk bulk run, in flight or finished. */
export interface LeftBehindRun {
  verb: "reregister" | "delete";
  running: boolean;
  done: number;
  total: number;
  failed: Array<{ path: string; reason: string }>;
}

/** One check's action, in flight or finished. */
export interface CheckRun {
  plan: CheckActionPlan;
  running: boolean;
  /** Progress while `running`; both 0 before the first report. */
  done: number;
  total: number;
  outcome: CheckActionOutcome | null;
}

// ── Section chrome ────────────────────────────────────────────────────────────

/**
 * A page section: the uppercase eyebrow every settings tab uses, one muted line
 * saying what the section is for, and an optional control on the right.
 */
export function Section({
  title,
  description,
  right,
  children,
}: {
  title: string;
  description?: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="health-section">
      <div className="health-section-head">
        <div className="health-section-titles">
          <div className="subhead">{title}</div>
          {description && <p className="health-section-desc">{description}</p>}
        </div>
        {right && <div className="health-section-right">{right}</div>}
      </div>
      {children}
    </section>
  );
}

/** The tiny uppercase label over a block inside an expanded panel. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="health-eyebrow">{children}</div>;
}

// ── Paths ─────────────────────────────────────────────────────────────────────

/** A vault-relative path: elided in the middle, whole in the tooltip. */
export function PathText({
  path,
  chars = PATH_CHARS,
  className,
}: {
  path: string;
  chars?: number;
  className?: string;
}) {
  return (
    <span className={`health-path${className ? ` ${className}` : ""}`} title={path}>
      {middleTruncate(path, chars)}
    </span>
  );
}

// ── Copy ──────────────────────────────────────────────────────────────────────

/** Copy one short value (an id, a raw error) with the confirmation on the
 *  button itself — a toast at the other end of the window says nothing about
 *  which of nine rows was copied. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="icon-btn health-copy"
      title={copied ? "Copied" : label}
      aria-label={copied ? "Copied" : label}
      onClick={() => {
        void copyText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Glyph name="check" /> : <Glyph name="copy" />}
    </button>
  );
}

// ── Chips ─────────────────────────────────────────────────────────────────────

/** A filter chip. `count` renders as a quiet trailing number rather than as
 *  part of the label, so the widths stay even as counts change. */
export function Chip({
  active,
  onClick,
  children,
  count,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  count?: number;
}) {
  return (
    <button
      type="button"
      className={`health-chip${active ? " active" : ""}`}
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
      {count != null && <span className="health-chip-count">{count.toLocaleString()}</span>}
    </button>
  );
}

// ── Glyphs ────────────────────────────────────────────────────────────────────

export type GlyphName =
  | "check"
  | "alert"
  | "info"
  | "cross"
  | "chevron"
  | "copy"
  | "note"
  | "folder"
  | "paperclip"
  | "file"
  | "tag"
  | "link"
  | "empty"
  | "disk"
  | "database"
  | "history"
  | "search"
  | "spark";

const PATHS: Record<GlyphName, ReactNode> = {
  check: <path d="M20 6 9 17l-5-5" />,
  alert: (
    <>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8h.01M11 12h1v4h1" />
    </>
  ),
  cross: <path d="M18 6 6 18M6 6l12 12" />,
  chevron: <path d="m9 18 6-6-6-6" />,
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </>
  ),
  note: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </>
  ),
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  paperclip: (
    <path d="M21 11.5 12.5 20a5 5 0 0 1-7-7l8-8a3.5 3.5 0 1 1 5 5l-8 8a2 2 0 0 1-3-3l7.5-7.5" />
  ),
  file: (
    <>
      <path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z" />
      <path d="M13 3v6h6" />
    </>
  ),
  tag: (
    <>
      <path d="M3 12V5a2 2 0 0 1 2-2h7l9 9-9 9z" />
      <circle cx="8" cy="8" r="1.4" />
    </>
  ),
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" />
      <path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" />
    </>
  ),
  empty: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12h8" />
    </>
  ),
  disk: (
    <>
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </>
  ),
  database: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M9 9v11" />
    </>
  ),
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 4v4h4" />
      <path d="M12 8v4l3 2" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  // The heal mark: a wand's four-pointed sparkle. Used only on the one button
  // per row that fixes the finding itself, so it stays meaningful.
  spark: (
    <>
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
      <path d="M12 8.5 13.2 11l2.8 1-2.8 1-1.2 2.5L10.8 13 8 12l2.8-1z" />
    </>
  ),
};

/** The page's only icon set. Stroked, 1.8 weight, `currentColor` — so an icon
 *  takes the tone of whatever card it sits in without a second palette. */
export function Glyph({ name, size = 16 }: { name: GlyphName; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
