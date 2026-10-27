// "Look, it's here": after skills are added (Add to team, a marketplace import
// or Import all, New skill), the Skills grid scrolls the first card into view,
// glows every new card's border once
// (dim → bright → dim over 5s, no pulsing) and shows a "New" chip for at least
// 8s or until the card is clicked. The look is CSS
// (`.skills-card.is-highlight`); this hook decides which card,
// waits until the grid is showing, and scrolls.
//
// The "new" mark is kept for the session (sessionStorage, guarded): coming
// back to the tab within a few minutes shows it once more.

import { useCallback, useEffect, useRef, useState } from "react";

const RING_MS = 5000;
const TAG_MS = 8000;
const FIND_FRAMES = 60;
const RETURN_WINDOW_MS = 5 * 60_000;
const STORE_KEY = "context.skills.newIds";

type NewMarks = Record<string, { at: number; shownAgain?: boolean }>;

function readMarks(): NewMarks {
  try {
    const v = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? "{}") as unknown;
    return v && typeof v === "object" ? (v as NewMarks) : {};
  } catch {
    return {};
  }
}

function writeMarks(marks: NewMarks): void {
  try { sessionStorage.setItem(STORE_KEY, JSON.stringify(marks)); } catch { /* storage unavailable */ }
}

/** Skills marked new in the last few minutes and not yet shown again: shown once more, then spent. */
export function takeReturningNewIds(now = Date.now(), marks: NewMarks = readMarks()): { ids: string[]; next: NewMarks } {
  const next: NewMarks = {};
  const ids: string[] = [];
  for (const [id, m] of Object.entries(marks)) {
    if (now - m.at > RETURN_WINDOW_MS) continue;
    if (!m.shownAgain) ids.push(id);
    next[id] = { at: m.at, shownAgain: true };
  }
  return { ids, next };
}

export function useHighlightSkill(gridVisible: boolean) {
  const [target, setTarget] = useState<{ ids: string[]; n: number } | null>(null);
  const handled = useRef(0);
  const [ring, setRing] = useState<ReadonlySet<string>>(new Set());
  const [newIds, setNewIds] = useState<ReadonlySet<string>>(() => {
    // Returning to the tab: show recent marks once more (no glow, just the chip).
    const { ids, next } = takeReturningNewIds();
    writeMarks(next);
    return new Set(ids);
  });

  /**
   * Highlight these skills now, or as soon as the grid is showing again. Calls
   * made while one is still waiting for the grid add to it (a run of quick
   * adds, an Import all), so every new card glows together.
   */
  const highlight = useCallback((skillIds: string | readonly string[]) => {
    const ids = typeof skillIds === "string" ? [skillIds] : [...skillIds];
    if (ids.length === 0) return;
    const marks = readMarks();
    for (const id of ids) marks[id] = { at: Date.now() };
    writeMarks(marks);
    setTarget((t) => {
      const waiting = t && handled.current !== t.n ? t.ids : [];
      return { ids: [...waiting, ...ids.filter((id) => !waiting.includes(id))], n: (t?.n ?? 0) + 1 };
    });
  }, []);

  /** The card was opened: its chip has done its job. */
  const seen = useCallback((skillId: string) => {
    setNewIds((s) => {
      if (!s.has(skillId)) return s;
      const next = new Set(s);
      next.delete(skillId);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!target || !gridVisible || handled.current === target.n) return;
    handled.current = target.n;
    setRing(new Set(target.ids));
    setNewIds((s) => new Set([...s, ...target.ids]));
    const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    // The card may land a moment later (the catalog reloads): look for a few frames.
    let frames = 0;
    let raf = 0;
    const find = () => {
      const el = document.querySelector(`[data-skill-id="${CSS.escape(target.ids[0])}"]`);
      if (el) el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
      else if (frames++ < FIND_FRAMES) raf = requestAnimationFrame(find);
    };
    raf = requestAnimationFrame(find);
    return () => cancelAnimationFrame(raf);
  }, [target, gridVisible]);

  useEffect(() => {
    if (ring.size === 0) return;
    const t = setTimeout(() => setRing(new Set()), RING_MS);
    return () => clearTimeout(t);
  }, [ring]);

  useEffect(() => {
    if (newIds.size === 0) return;
    const t = setTimeout(() => setNewIds(new Set()), TAG_MS);
    return () => clearTimeout(t);
  }, [newIds]);

  /** A highlight is waiting for the grid (it will scroll the card itself). */
  const pending = !!target && handled.current !== target.n;
  return { highlight, seen, ringIds: ring, newIds, pending };
}
