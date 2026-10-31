// Instant tooltips for the install squares (+, ✓, !) and the Required badge,
// instead of the OS `title` that shows late or not at all. Hover or focus shows
// a small card under the anchor after TIP_DELAY_MS; a Required ✓ also opens the
// same text as a popover on click (Enter/Space), with "Make optional" for
// admins and "Got it" for everyone, so a press never does nothing.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { placeMenu, type Placement } from "../../lib/menuPlacement";
import { toast } from "../../lib/toast";
import { AsyncButton } from "../AsyncButton";

export const TIP_DELAY_MS = 150;

export interface TipContent {
  heading: string;
  body?: string;
  /** Per-tool lines ("Claude: Installed v1"). */
  lines?: readonly string[];
  /** A quieter last line (e.g. the admin hint). */
  note?: string;
}

/** A square's `title` ("Heading\nline\nline") as tip content. */
export function tipFromTitle(title: string): TipContent {
  const [heading, ...lines] = title.split("\n").filter(Boolean);
  return { heading: heading ?? "", lines };
}

/** The Required text: why it can't be removed, per-tool lines, and for admins where to change it. */
export function requiredTip(lines: readonly string[], canManage: boolean): TipContent {
  return {
    heading: "Required by your team",
    body: "It's always installed on everyone's computer and can't be removed.",
    lines,
    note: canManage ? "Change it to Optional on the skill's page." : undefined,
  };
}

/** One string for aria-label. */
export function tipText(c: TipContent): string {
  return [c.heading, c.body, ...(c.lines ?? []), c.note]
    .filter((x): x is string => !!x)
    .map((x) => x.replace(/\.$/, ""))
    .join(". ");
}

/** Hover/focus state with the short delay, plus the pinned (clicked) popover. */
export function useAnchoredTip<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const show = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setHover(true), TIP_DELAY_MS);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    setHover(false);
  };
  return {
    ref,
    hover,
    pinned,
    setPinned,
    handlers: { onMouseEnter: show, onMouseLeave: hide, onFocus: show, onBlur: hide },
  };
}

/**
 * The card itself, portalled and placed under the anchor (flipped above near
 * the bottom). `actions` makes it a popover that stays until dismissed.
 */
export function TipCard({
  anchor,
  content,
  actions,
  onClose,
}: {
  anchor: HTMLElement | null;
  content: TipContent;
  actions?: ReactNode;
  onClose?: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<Placement | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) return;
    const r = anchor.getBoundingClientRect();
    setPos(
      placeMenu(
        { x: Math.max(8, r.right - el.offsetWidth), y: r.bottom + 6, flipY: r.top - 6 },
        { width: el.offsetWidth, height: el.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [anchor, content]);

  // A popover closes on an outside press, Escape, scroll or resize.
  useEffect(() => {
    if (!actions || !onClose) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
      anchor?.focus();
    };
    const dismiss = () => onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [actions, onClose, anchor]);

  return createPortal(
    <div
      ref={ref}
      className={`skills-tip${actions ? " is-popover" : ""}`}
      role={actions ? "dialog" : "tooltip"}
      aria-label={actions ? content.heading : undefined}
      style={pos ? { left: pos.left, top: pos.top } : { visibility: "hidden", left: 0, top: 0 }}
      // Portalled, but React still bubbles to the card that holds the anchor.
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="skills-tip-heading">{content.heading}</div>
      {content.body && <div className="skills-tip-body">{content.body}</div>}
      {content.lines && content.lines.length > 0 && (
        <div className="skills-tip-lines">
          {content.lines.map((l) => (
            <div key={l}>{l}</div>
          ))}
        </div>
      )}
      {content.note && <div className="skills-tip-note">{content.note}</div>}
      {actions && <div className="skills-tip-actions">{actions}</div>}
    </div>,
    document.body,
  );
}

/** The Required popover's buttons: "Make optional" (admins) and "Got it". */
export function RequiredActions({
  name,
  onMakeOptional,
  onClose,
}: {
  name: string;
  onMakeOptional?: () => Promise<void>;
  onClose: () => void;
}) {
  return (
    <>
      {onMakeOptional && (
        <AsyncButton
          className="secondary skills-btn-sm"
          onClick={async () => {
            try {
              await onMakeOptional();
              onClose();
            } catch (e) {
              toast(`Couldn't make ${name} optional: ${e instanceof Error ? e.message : String(e)}`, "error");
            }
          }}
        >
          Make optional
        </AsyncButton>
      )}
      <button type="button" className={`${onMakeOptional ? "ghost-pill" : "secondary"} skills-btn-sm`} onClick={onClose}>
        Got it
      </button>
    </>
  );
}

/** The instant tooltip around a control that owns its own click (e.g. a menu square). */
export function TipAnchor({ content, children }: { content: TipContent; children: ReactNode }) {
  const tip = useAnchoredTip<HTMLSpanElement>();
  return (
    <>
      {/* A press opens the button's own menu: the hover tip steps aside rather
          than covering it, and its focus-show is ignored while that menu is up. */}
      <span
        ref={tip.ref}
        className="skills-tip-anchor"
        {...tip.handlers}
        onFocus={(e) => {
          if (!tip.ref.current?.querySelector('[aria-expanded="true"]')) tip.handlers.onFocus();
          void e;
        }}
        onPointerDownCapture={tip.handlers.onMouseLeave}
      >
        {children}
      </span>
      {tip.hover && <TipCard anchor={tip.ref.current} content={content} />}
    </>
  );
}

/**
 * The skill page's "✓ Installed for everyone": a Required skill can't be
 * removed, so hovering explains why and a click (Enter/Space) opens the same
 * text, with "Make optional" for admins.
 */
export function RequiredBadge({
  name,
  lines,
  canManage,
  onMakeOptional,
  children,
}: {
  name: string;
  lines: readonly string[];
  canManage: boolean;
  onMakeOptional?: () => Promise<void>;
  children: ReactNode;
}) {
  const tip = useAnchoredTip<HTMLButtonElement>();
  const content = requiredTip(lines, canManage);
  return (
    <>
      <button
        ref={tip.ref}
        type="button"
        className="skills-installed-static"
        aria-label={tipText(content)}
        aria-haspopup="dialog"
        aria-expanded={tip.pinned}
        {...tip.handlers}
        onClick={() => tip.setPinned((v) => !v)}
      >
        {children}
      </button>
      {tip.pinned ? (
        <TipCard
          anchor={tip.ref.current}
          content={content}
          onClose={() => tip.setPinned(false)}
          actions={<RequiredActions name={name} onMakeOptional={onMakeOptional} onClose={() => tip.setPinned(false)} />}
        />
      ) : (
        tip.hover && <TipCard anchor={tip.ref.current} content={content} />
      )}
    </>
  );
}
