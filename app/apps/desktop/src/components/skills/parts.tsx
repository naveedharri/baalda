// Small shared pieces for the skills screens, so the Skills tab, a skill's
// page, the marketplace and AI tools draw rows, tags, status and loading the
// same way.

import { forwardRef, useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import { useAsyncAction } from "../../lib/useAsyncAction";
import { Spinner } from "../Spinner";
import * as ipc from "../../lib/ipc";
import { skillDisplayName } from "../../lib/skills/display";
import { RequiredActions, requiredTip, TipCard, tipFromTitle, tipText, useAnchoredTip, type TipContent } from "./SquareTip";
import type { SkillDetail, SkillSummary } from "../../lib/skills/types";
import type { SkillTarget } from "../../lib/ipc";

/**
 * Who a skill is by: the repo owner for an imported skill (linking to the
 * repo), else the person who published its latest version.
 */
export function skillAuthor(s: SkillSummary | SkillDetail): { name: string; url?: string } | null {
  if (s.source) {
    return { name: s.source.repo.split("/")[0], url: `https://github.com/${s.source.repo}` };
  }
  const versions = "versions" in s ? s.versions : [];
  const name = s.latestPublishedBy?.name ?? versions[0]?.publishedBy?.name ?? null;
  return name ? { name } : null;
}

/** "Oct 26", with the year when it isn't this year. */
function shortDate(d: Date): string {
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/** Claude Desktop's plugin-header style: `by anthropics · v3 · 6 files · updated Oct 26`. */
export function SkillByline({ skill }: { skill: SkillDetail }) {
  const author = skillAuthor(skill);
  const effective = skill.versions.find((v) => v.version === skill.effectiveVersion) ?? null;
  const files = effective?.fileCount ?? skill.draftFiles?.length ?? null;
  const at = skill.latestPublishedAt ?? skill.versions[0]?.publishedAt ?? skill.updatedAt;
  const date = at ? new Date(at) : null;
  const parts: ReactNode[] = [];
  if (author) {
    parts.push(
      <span key="by">
        by{" "}
        {author.url ? (
          <button type="button" className="link-btn skills-byline-link" onClick={() => void ipc.openExternal(author.url!)} title={author.url}>
            {author.name}
          </button>
        ) : (
          author.name
        )}
      </span>,
    );
  }
  parts.push(<span key="v">{skill.effectiveVersion !== null ? `v${skill.effectiveVersion}` : "Draft"}</span>);
  if (files !== null) parts.push(<span key="f">{files} {files === 1 ? "file" : "files"}</span>);
  if (date && !Number.isNaN(date.getTime())) {
    parts.push(
      <span key="d" title={date.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" })}>
        {skill.latestPublishedAt || skill.versions[0] ? "updated" : "edited"} {shortDate(date)}
      </span>,
    );
  }
  return (
    <p className="skills-byline">
      {parts.flatMap((p, i) => (i === 0 ? [p] : [<span key={`s${i}`} aria-hidden="true"> · </span>, p]))}
    </p>
  );
}

export function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 4v5h-5" />
    </svg>
  );
}

/** The skill glyph: a page with lines, like Claude's skill list. */
/** The Agent Skills feature mark (a wrench): Vault Settings' tab and the sidebar shortcut. */
export const AGENT_SKILLS_ICON_PATH =
  "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z";

export function AgentSkillsGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={AGENT_SKILLS_ICON_PATH} />
    </svg>
  );
}

export function SkillGlyph({ size = 15 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6M9 17h4" />
    </svg>
  );
}

export function SkillIcon({ large = false }: { large?: boolean }) {
  return (
    <span className={`skills-icon${large ? " is-lg" : ""}`} aria-hidden="true">
      <SkillGlyph size={large ? 18 : 15} />
    </span>
  );
}

/** The install square's "!" (edited, name taken, failed), for a square that opens a menu. */
export function WarnMark() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 3.5v5.5M8 12.2v.3" />
    </svg>
  );
}

export type InstallKind = "add" | "installed" | "required" | "busy" | "warn" | "bad" | "update" | "blocked";

/**
 * Claude Desktop's install square: "+" to use a skill on this computer, a
 * green "✓" when it is here, "!" for a problem. Clicks never reach the card
 * underneath. `title` ("Heading\nline…") shows as an instant tooltip
 * (`SquareTip.tsx`), never the OS one. A Required ✓ can't be removed, so it
 * says why: a padlock instead of the ✓, `cursor: help`, and a click (Enter/Space) opens the
 * same text as a popover, with "Make optional" when `onMakeOptional` is given
 * (admins) and "Got it" for everyone.
 */
export function InstallButton({
  kind,
  title,
  onClick,
  large = false,
  name = "",
  canManage = false,
  onMakeOptional,
}: {
  kind: InstallKind;
  title: string;
  onClick?: () => void;
  /** 30px (list rows) rather than 26px (cards). */
  large?: boolean;
  /** Required only: the skill's name (for an error toast). */
  name?: string;
  /** Required only: adds "Change it to Optional on the skill's page." */
  canManage?: boolean;
  /** Required only, admins: the popover's "Make optional". */
  onMakeOptional?: () => Promise<void>;
}) {
  const tip = useAnchoredTip<HTMLButtonElement>();
  const required = kind === "required";
  const content: TipContent = required
    ? requiredTip(tipFromTitle(title).lines?.filter((l) => l !== "Required by your team") ?? [], canManage)
    : tipFromTitle(title);
  const passive = !required && (kind === "busy" || kind === "blocked" || !onClick);
  return (
    <>
      <button
        ref={tip.ref}
        type="button"
        className={`skills-install is-${kind}${large ? " is-lg" : ""}`}
        aria-label={tipText(content)}
        aria-disabled={passive || undefined}
        aria-haspopup={required ? "dialog" : undefined}
        aria-expanded={required ? tip.pinned : undefined}
        {...tip.handlers}
        onClick={(e) => {
          e.stopPropagation();
          if (required) tip.setPinned((v) => !v);
          else if (!passive) onClick?.();
        }}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {kind === "busy" ? (
          <span className="spinner spinner-xs spinner-inherit" aria-hidden="true" />
        ) : (
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {kind === "add" ? (
              <path d="M8 3v10M3 8h10" />
            ) : kind === "update" ? (
              <path d="M8 13V3.5M4 7l4-4 4 4" />
            ) : kind === "blocked" ? (
              <path d="M4.5 8h7" />
            ) : kind === "warn" || kind === "bad" ? (
              <path d="M8 3.5v5.5M8 12.2v.3" />
            ) : required ? (
              // One padlock in the green square: on this computer, and fixed by the team.
              <>
                <rect x="3.75" y="7.25" width="8.5" height="6" rx="1.5" />
                <path d="M5.5 7.25V5.5a2.5 2.5 0 0 1 5 0v1.75" />
              </>
            ) : (
              <path d="m3.5 8.5 3 3 6-7" />
            )}
          </svg>
        )}
      </button>
      {tip.pinned ? (
        <TipCard
          anchor={tip.ref.current}
          content={content}
          onClose={() => tip.setPinned(false)}
          actions={<RequiredActions name={skillDisplayName(name)} onMakeOptional={onMakeOptional} onClose={() => tip.setPinned(false)} />}
        />
      ) : (
        tip.hover && content.heading && <TipCard anchor={tip.ref.current} content={content} />
      )}
    </>
  );
}

/** The small padlock on a Required ✓: fixed, not a toggle. */
export function LockBadge() {
  return (
    <span className="skills-lock-badge" aria-hidden="true">
      <svg viewBox="0 0 12 12" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2.5" y="5.5" width="7" height="5" rx="1" />
        <path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" />
      </svg>
    </span>
  );
}

/** A quiet label pill: `v3`, `Optional`, `Imported`. `tone` borrows the access colours. */
export function Tag({ children, tone, title }: { children: ReactNode; tone?: "good" | "warn"; title?: string }) {
  return (
    <span className={`skills-tag${tone ? ` is-${tone}` : ""}`} title={title}>
      {children}
    </span>
  );
}

export const TARGET_SHORT: Record<SkillTarget, string> = { claude: "Claude", agents: "Other tools" };

/**
 * A card's description: at most three lines, clipped without "…". Only when it
 * actually overflows does the end of the last line fade out (`is-clipped`).
 */
export function CardDescription({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setClipped(el.scrollHeight > el.clientHeight + 1);
    check();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);
  return (
    <span ref={ref} className={`skills-card-desc${clipped ? " is-clipped" : ""}`}>
      {text}
    </span>
  );
}

/**
 * One skill card in a `.skills-grid` (the Skills tab's team and device grids,
 * Account Settings → AI tools): the neutral tile, `/name` (plus `titleExtra`,
 * e.g. the "New" chip), a muted one-line byline, the clamped description, and
 * at the top right the install square with an optional hover ⋯ (`more`).
 * `li` carries the card's own props: click/keys to open, data attributes, a
 * state class. Without an `onClick` there it is static.
 */
export function SkillCard({
  name,
  titleExtra,
  byline,
  description,
  action,
  more,
  className = "",
  li,
}: {
  name: string;
  titleExtra?: ReactNode;
  byline: ReactNode;
  description: string;
  action?: ReactNode;
  more?: ReactNode;
  className?: string;
  li?: HTMLAttributes<HTMLLIElement> & Record<`data-${string}`, string>;
}) {
  const interactive = !!li?.onClick;
  return (
    <li {...li} className={`skills-card${more ? " has-more" : ""}${interactive ? "" : " is-static"}${className ? ` ${className}` : ""}`}>
      <SkillIcon large />
      <span className="skills-card-main">
        <span className="skills-card-title-row">
          <span className="skills-row-name">{skillDisplayName(name)}</span>
          {titleExtra}
        </span>
        <span className="skills-card-byline">{byline}</span>
        <CardDescription text={description} />
      </span>
      {(action || more) && (
        <span className="skills-card-action">
          {more && (
            // The menu is portalled, but React still bubbles its clicks up
            // here: keep them from opening the card.
            <span className="skills-card-more" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
              {more}
            </span>
          )}
          {action}
        </span>
      )}
    </li>
  );
}

/** Placeholder cards matching `.skills-grid` cards (neutral, no tile colour): title, byline, three description lines. */
export function SkeletonCards({ count = 3, label = "Loading" }: { count?: number; label?: string }) {
  return (
    <ul className="skills-grid" role="status" aria-busy="true" aria-label={label}>
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="skills-card is-static" aria-hidden="true">
          <span className="skel-line skills-skel-icon is-lg" />
          <span className="skills-card-main">
            <span className="skel-line" style={{ width: `${28 + (i % 3) * 10}%` }} />
            <span className="skel-line skills-skel-sub skills-skel-byline" style={{ width: "34%" }} />
            <span className="skel-line skills-skel-sub" style={{ width: "94%" }} />
            <span className="skel-line skills-skel-sub" style={{ width: "88%" }} />
            <span className="skel-line skills-skel-sub" style={{ width: "56%" }} />
          </span>
          <span className="skills-card-action">
            <span className="skel-line skills-skel-install" />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** GitHub's mark, for import-source group headers. */
export function GitHubGlyph() {
  return (
    <svg className="skills-gh" viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
      />
    </svg>
  );
}

export function EmptyState({
  title,
  children,
  actions,
}: {
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="skills-empty">
      <span className="skills-empty-icon" aria-hidden="true">
        <SkillGlyph size={22} />
      </span>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {actions && <div className="skills-empty-actions">{actions}</div>}
    </div>
  );
}

/**
 * The toolbar's search: an icon that opens into a compact input. ⌘F or "/"
 * opens it too while this view is up (`hotkeys`); Esc, or leaving it empty,
 * folds it back. While a query is set it stays open with a clear ×.
 */
export function SearchToggle({
  value,
  onChange,
  placeholder,
  hotkeys = false,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  hotkeys?: boolean;
}) {
  const [open, setOpen] = useState(value !== "");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const expanded = open || value !== "";

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!hotkeys) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      const find = (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "f";
      if (find || (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey)) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(true);
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [hotkeys]);

  if (!expanded) {
    return (
      <span className="member-access-view">
        <button type="button" className="member-access-view-btn" aria-label="Search" title="Search (⌘F)" onClick={() => setOpen(true)}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
        </button>
      </span>
    );
  }
  return (
    <span className="member-access-view skills-search">
      <svg className="skills-search-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <span className="skills-search-field">
        <input
          ref={inputRef}
          className="skills-search-input"
          placeholder={placeholder}
          aria-label={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              onChange("");
              setOpen(false);
            }
          }}
          onBlur={() => {
            if (!value) setOpen(false);
          }}
        />
      </span>
      {value && (
        <button
          type="button"
          className="member-access-view-btn skills-search-clear"
          aria-label="Clear search"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            onChange("");
            inputRef.current?.focus();
          }}
        >
          ×
        </button>
      )}
    </span>
  );
}

/**
 * A button that says what it is doing: while `onClick` runs it is disabled
 * (double clicks dropped), `aria-busy`, and shows a spinner with `busyLabel`
 * ("Publishing…"). Both labels share one grid cell, so the button keeps the
 * width of the wider one and never jumps.
 */
export const BusyButton = forwardRef<
  HTMLButtonElement,
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> & {
    onClick: () => Promise<unknown> | unknown;
    busyLabel: string;
    children: ReactNode;
  }
>(function BusyButton({ onClick, busyLabel, children, className, disabled, ...rest }, ref) {
  const action = useAsyncAction(onClick, { swallow: true });
  const busy = action.showPending;
  return (
    <button
      type="button"
      {...rest}
      ref={ref}
      className={`${className ?? ""}${busy ? " is-busy" : ""}`.trim()}
      disabled={disabled || action.pending}
      aria-busy={action.pending || undefined}
      onClick={() => void action.run()}
    >
      <span className="skills-busy-stack">
        <span className={busy ? "is-hidden" : undefined}>{children}</span>
        <span className={busy ? undefined : "is-hidden"} aria-hidden={!busy}>
          <Spinner size="xs" tone={className?.includes("primary") ? "on-accent" : "inherit"} />
          {busyLabel}
        </span>
      </span>
    </button>
  );
});

// ---- Loading states ----------------------------------------------------------
//
// Built on the app's own shimmer (`.skel-line`, editor.css), which already
// stills itself under prefers-reduced-motion. Each preset has the shape of the
// thing it stands in for, so the page doesn't jump when content lands.

export function Skeleton({ w, h, className, style }: { w?: number | string; h?: number | string; className?: string; style?: React.CSSProperties }) {
  return <span className={`skel-line${className ? ` ${className}` : ""}`} style={{ width: w, height: h, ...style }} aria-hidden="true" />;
}

/** A group header and a grid of card skeletons (the Skills tab's first load). */
export function SkillGridSkeleton({ count = 6, label = "Loading skills" }: { count?: number; label?: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label}>
      <div className="skills-group-head" aria-hidden="true">
        <Skeleton w={120} h={11} />
      </div>
      <SkeletonCards count={count} label={label} />
    </div>
  );
}

/** A skill page's header row: tile, name + pill, byline, control group. */
export function SkillHeaderSkeleton() {
  return (
    <div className="skills-detail-head" role="status" aria-busy="true" aria-label="Loading skill">
      <Skeleton className="skills-skel-icon is-lg" />
      <div className="skills-detail-title">
        <div className="skills-title-row">
          <Skeleton w={160} h={16} />
          <Skeleton w={110} h={20} style={{ borderRadius: "var(--radius-pill)" }} />
        </div>
        <Skeleton w={240} h={10} style={{ marginTop: 8 }} />
      </div>
      <div className="skills-detail-controls">
        <Skeleton w={92} h={34} style={{ borderRadius: "var(--radius-md)" }} />
        <Skeleton w={104} h={34} style={{ borderRadius: "var(--radius-md)" }} />
        <Skeleton w={34} h={34} style={{ borderRadius: "var(--radius-md)" }} />
      </div>
    </div>
  );
}

/** The "Available in" line. */
export function AvailableSkeleton() {
  return (
    <div className="skills-available" aria-hidden="true">
      <Skeleton w={110} h={10} />
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} w={64} h={14} />
      ))}
    </div>
  );
}

/** Body lines only, for a file that is loading inside a ready editor. */
export function EditorBodySkeleton() {
  return (
    <div className="skills-editor-body-skel" role="status" aria-busy="true" aria-label="Loading file">
      {[72, 88, 64, 92, 40, 80, 56].map((w, i) => (
        <Skeleton key={i} w={`${w}%`} h={10} />
      ))}
    </div>
  );
}

/** The whole editor frame: tree rows, pane header, Name/Description, body. */
export function EditorSkeleton() {
  return (
    <div className="skills-editor" role="status" aria-busy="true" aria-label="Loading files">
      <div className="skills-tree">
        <div className="skills-tree-head"><Skeleton w={40} h={9} /></div>
        <div className="skills-tree-skel">
          {[70, 52, 60, 44, 66].map((w, i) => (
            <span key={i} className="skills-tree-skel-row" style={{ paddingLeft: i === 2 || i === 3 ? 20 : 6 }}>
              <Skeleton w={14} h={14} />
              <Skeleton w={`${w}%`} h={9} />
            </span>
          ))}
        </div>
      </div>
      <div className="skills-pane">
        <div className="skills-pane-head"><Skeleton w={140} h={9} /></div>
        <div className="skills-md-header">
          <Skeleton w={40} h={9} />
          <Skeleton w={120} h={10} />
          <Skeleton w={64} h={9} />
          <Skeleton w="80%" h={10} />
        </div>
        <EditorBodySkeleton />
      </div>
    </div>
  );
}

/** Row placeholders with a square on the right (marketplace and versions). */
export function RowSkeletons({ count = 4, label = "Loading", square = true }: { count?: number; label?: string; square?: boolean }) {
  return (
    <ul className="skills-list" role="status" aria-busy="true" aria-label={label}>
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="skills-list-row is-static" aria-hidden="true">
          <Skeleton className="skills-skel-icon" />
          <span className="skills-row-main">
            <Skeleton w={`${28 + (i % 3) * 10}%`} h={12} />
            <Skeleton className="skills-skel-sub" w={`${40 + (i % 2) * 12}%`} />
            <Skeleton className="skills-skel-sub" w={`${60 + (i % 2) * 18}%`} />
          </span>
          {square && <span className="skills-row-action"><Skeleton w={30} h={30} style={{ borderRadius: "var(--radius-md)" }} /></span>}
        </li>
      ))}
    </ul>
  );
}

/** AI tools' folder rows: label + hint on the left, a switch on the right. */
export function ToolRowSkeleton() {
  return (
    <>
      {[0, 1].map((i) => (
        <div key={i} className="menu-row toggle-row" role="status" aria-busy="true" aria-label="Loading">
          <span className="menu-row-label">
            <Skeleton w={150} h={12} />
            <Skeleton w={220} h={9} style={{ display: "block", marginTop: 6 }} />
          </span>
          <Skeleton w={34} h={20} style={{ borderRadius: "var(--radius-pill)" }} />
        </div>
      ))}
    </>
  );
}

/** A thin bar over content that is refreshing: the old content stays put. */
export function ProgressBar({ active }: { active: boolean }) {
  return <div className={`skills-progress${active ? " is-active" : ""}`} role={active ? "progressbar" : undefined} aria-hidden={!active} />;
}

/** A calm inline failure with Try again: never a stuck skeleton. */
export function LoadError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="skills-load-error" role="alert">
      <span>{message}</span>
      {onRetry && (
        <button type="button" className="secondary skills-btn-sm" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

/**
 * Path text with each home "~" set on the centre line: fonts draw the tilde
 * near the cap height, which reads as floating beside "/.claude/skills".
 */
export function withTildes(text: string): ReactNode {
  if (!text.includes("~/")) return text;
  return text.split(/(~(?=\/))/).map((part, i) =>
    part === "~" ? (
      <span key={i} className="skills-tilde">
        ~
      </span>
    ) : (
      part
    ),
  );
}
