/* The right-side pop-out panel: Activity (one feed of reconnect results,
   server Trash and local recovery copies) and Versions (the open note's
   history). Push-to-talk lives in the main toolbar, not here. One
   container, the old version panel's slide-in and close rules: Escape, the ✕,
   or a click outside it (the toolbar toggle and the editor-area virtual tabs
   excepted, so it coexists with "Review changes"). */
import { useEffect, useRef } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import "./health.css";
import { useStore } from "../store";
import { ErrorBoundary } from "./ErrorBoundary";
import { VersionsTab } from "./VersionPanel";
import { ActivityFeed } from "./ActivityFeed";
import { usePendingReviewCount } from "./ReviewTab";
import { RIGHT_PANEL_TAB_LABEL, RIGHT_PANEL_TABS, type RightPanelTab } from "./rightPanelTab";

/** Portaled UI the panel opens: ConfirmDialog (modal), RowActionsMenu
 *  (`.menu-portal`), toasts. A click there must not close the panel under it. */
const PANEL_SPAWNED = ".panel-btn, .modal-backdrop, .modal, .menu-portal, .toast, .toast-viewport";

const ICON_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

/** The panel's tab switchers: Version history's clock and Activity's
 *  bulleted log (three bullets, three lines), distinct from the clock beside it. */
const TAB_ICON: Record<RightPanelTab, React.ReactNode> = {
  activity: (
    <svg {...ICON_PROPS}>
      <circle cx="5" cy="6" r="1.4" />
      <circle cx="5" cy="12" r="1.4" />
      <circle cx="5" cy="18" r="1.4" />
      <path d="M10 6h10M10 12h10M10 18h7" />
    </svg>
  ),
  versions: (
    <svg {...ICON_PROPS}>
      <path d="M3 12a9 9 0 1 0 2.6-6.4" />
      <path d="M3 4v4h4" />
      <path d="M12 8v4l3 2" />
    </svg>
  ),
};

/** Same titles/labels the header buttons carried. */
const TAB_TITLE: Record<RightPanelTab, string> = {
  activity: "Activity",
  versions: "Version history",
};

/** The old buttons' classes, so their active styling carries over. */
const TAB_CLASS: Record<RightPanelTab, string> = {
  activity: "activity-tab-btn",
  versions: "history-btn",
};

function PanelBody({ tab }: { tab: RightPanelTab }) {
  const reduceMotion = useReducedMotion();
  const ref = useRef<HTMLElement | null>(null);
  const pending = usePendingReviewCount();

  // preventScroll: the panel is still off-screen right while it slides in.
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      if (target instanceof Element) {
        // Only the toggle itself and the dialogs / menus / popovers the panel
        // spawns (portaled outside it). Anything else, the editor, tab strip,
        // sidebar or a Review changes tab included, closes the panel.
        if (target.closest(PANEL_SPAWNED)) return;
      }
      useStore.getState().closeRightPanel();
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, []);

  const close = () => useStore.getState().closeRightPanel();
  return (
    <motion.aside
      ref={ref}
      className="version-panel right-panel"
      tabIndex={-1}
      role="dialog"
      aria-label="Panel"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          close();
          e.preventDefault();
        }
      }}
      initial={reduceMotion ? { opacity: 0 } : { x: "100%" }}
      animate={reduceMotion ? { opacity: 1 } : { x: 0 }}
      exit={reduceMotion ? { opacity: 0 } : { x: "100%" }}
      transition={reduceMotion ? { duration: 0.12 } : { duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
    >
      <header className="right-panel-head">
        <div className="right-panel-tabs" role="tablist" aria-label="Panel">
          {RIGHT_PANEL_TABS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={t === tab}
              aria-pressed={t === tab}
              aria-label={
                t === "activity" && pending > 0 ? `${TAB_TITLE[t]}, ${pending} to review` : TAB_TITLE[t]
              }
              title={TAB_TITLE[t]}
              className={`icon-btn right-panel-tab ${TAB_CLASS[t]}${t === tab ? " active" : ""}`}
              onClick={() => useStore.getState().setRightPanelTab(t)}
            >
              {TAB_ICON[t]}
              {t === "activity" && pending > 0 && (
                <span className="right-panel-count" aria-hidden="true">
                  {pending > 99 ? "99+" : pending}
                </span>
              )}
            </button>
          ))}
          <span className="right-panel-tab-name">{RIGHT_PANEL_TAB_LABEL[tab]}</span>
        </div>
        <button className="icon-btn" onClick={close} aria-label="Close panel" title="Close (Esc)">
          ✕
        </button>
      </header>
      <div className="right-panel-body">
        <ErrorBoundary label={RIGHT_PANEL_TAB_LABEL[tab]} resetKeys={[tab]}>
          {tab === "activity" ? <ActivityFeed /> : <VersionsTab />}
        </ErrorBoundary>
      </div>
    </motion.aside>
  );
}

export function RightPanel() {
  // A missing or unknown tab (older state, a bad write) opens Activity rather than throwing.
  const tab = useStore((s) => {
    const t = s.rightPanel?.tab;
    if (s.rightPanel == null) return null;
    return (RIGHT_PANEL_TABS as readonly string[]).includes(t ?? "") ? (t as RightPanelTab) : "activity";
  });
  return <AnimatePresence>{tab && <PanelBody tab={tab} />}</AnimatePresence>;
}
