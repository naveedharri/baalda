/* The editor area's non-note views: a read-only text tab (a recovery copy or a
   deleted note's preview) and a compare tab (copy vs current note, side by
   side or unified when narrow). Chosen by `VirtualTabView` from the store's
   active virtual tab. */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import "./compare.css";
import { useStore } from "../store";
import { mountCompare, mountReadOnly, UNIFIED_BELOW_PX } from "../lib/editor/compareView";
import { loadSource, sourceErrorMessage } from "./textSources";
import { sourceKey, type TextSource, type VirtualTab } from "./virtualTabs";
import { lineChanges, formatLineChanges } from "./lineChanges";

type Loaded = { state: "loading" } | { state: "error"; message: string } | { state: "ok"; text: string };

function useSourceText(source: TextSource, nonce: number): Loaded {
  const epoch = useStore((s) => s.vault?.epoch);
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const key = sourceKey(source);
  useEffect(() => {
    let cancelled = false;
    setLoaded({ state: "loading" });
    loadSource(source, epoch).then(
      (text) => !cancelled && setLoaded({ state: "ok", text }),
      (e) => !cancelled && setLoaded({ state: "error", message: sourceErrorMessage(e) }),
    );
    return () => {
      cancelled = true;
    };
    // `source` is identified by its key; the object itself changes per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, epoch, nonce]);
  return loaded;
}

/** Split when the host is wide enough, unified otherwise. */
function useCompareMode(ref: React.RefObject<HTMLElement | null>): "split" | "unified" {
  const [mode, setMode] = useState<"split" | "unified">("split");
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry?.contentRect.width ?? el.clientWidth;
      setMode(w < UNIFIED_BELOW_PX ? "unified" : "split");
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return mode;
}

export function ReadOnlyText({ source, nonce = 0 }: { source: TextSource; nonce?: number }) {
  const loaded = useSourceText(source, nonce);
  const host = useRef<HTMLDivElement | null>(null);
  const text = loaded.state === "ok" ? loaded.text : null;
  useEffect(() => {
    if (text == null || !host.current) return;
    const h = mountReadOnly(host.current, text);
    return () => h.destroy();
  }, [text]);
  if (loaded.state === "loading") return <p className="muted vtab-status">Loading…</p>;
  if (loaded.state === "error")
    return (
      <p role="alert" className="auth-error vtab-error">
        {loaded.message}
      </p>
    );
  return <div className="vtab-body" ref={host} />;
}

export interface CompareProps {
  left: { label: string; source: TextSource };
  right: { label: string; source: TextSource };
  /** Rendered in the header, beside the labels (e.g. "Restore this copy"). */
  actions?: ReactNode;
  /** Bump to re-read both sides (after a restore, or on Refresh). */
  nonce?: number;
  /** Called with the line counts once both sides load. */
  onCounts?: (counts: { added: number; removed: number }) => void;
}

export function CompareBody({ left, right, actions, nonce = 0, onCounts }: CompareProps) {
  const [localNonce, setLocalNonce] = useState(0);
  const a = useSourceText(left.source, nonce + localNonce);
  const b = useSourceText(right.source, nonce + localNonce);
  const host = useRef<HTMLDivElement | null>(null);
  const mode = useCompareMode(host);
  const aText = a.state === "ok" ? a.text : null;
  const bText = b.state === "ok" ? b.text : null;
  const counts = aText != null && bText != null ? lineChanges(aText, bText) : null;

  useEffect(() => {
    if (counts) onCounts?.(counts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [counts?.added, counts?.removed]);

  useEffect(() => {
    if (aText == null || bText == null || !host.current) return;
    const h = mountCompare(host.current, aText, bText, mode);
    return () => h.destroy();
  }, [aText, bText, mode]);

  const error = a.state === "error" ? a.message : b.state === "error" ? b.message : null;
  return (
    <div className="vtab-view">
      <div className="vtab-header">
        <div className="vtab-labels">
          <span className="vtab-label" title={left.label}>
            <strong>{left.label}</strong>
          </span>
          <span className="vtab-label" title={right.label}>
            <strong>{right.label}</strong>
          </span>
        </div>
        <div className="vtab-actions">
          {counts && <span className="muted">{formatLineChanges(counts)}</span>}
          <button type="button" className="ghost-pill sm" onClick={() => setLocalNonce((n) => n + 1)}>
            Refresh
          </button>
          {actions}
        </div>
      </div>
      {error ? (
        <p role="alert" className="auth-error vtab-error">
          {error}
        </p>
      ) : aText == null || bText == null ? (
        <p className="muted vtab-status">Loading…</p>
      ) : null}
      <div className="vtab-body" ref={host} />
    </div>
  );
}

function TextTab({ tab }: { tab: Extract<VirtualTab, { kind: "text" }> }) {
  return (
    <div className="vtab-view">
      <div className="vtab-header">
        <div className="vtab-labels">
          <span className="vtab-label">
            <strong>{tab.title}</strong>
            {tab.subtitle ? ` · ${tab.subtitle}` : ""}
          </span>
        </div>
        <span className="muted">Read-only</span>
      </div>
      <ReadOnlyText source={tab.source} />
    </div>
  );
}

/** Renders whichever virtual tab is active. The review tab is injected so this
 *  file does not depend on the review module. */
export function VirtualTabView({
  tab,
  renderCompareActions,
  renderReview,
}: {
  tab: VirtualTab;
  renderCompareActions?: (tab: Extract<VirtualTab, { kind: "compare" }>) => ReactNode;
  renderReview?: () => ReactNode;
}) {
  switch (tab.kind) {
    case "text":
      return <TextTab key={tab.id} tab={tab} />;
    case "compare":
      return (
        <CompareBody
          key={tab.id}
          left={tab.left}
          right={tab.right}
          actions={renderCompareActions?.(tab)}
        />
      );
    case "review":
      return <>{renderReview?.()}</>;
  }
}
