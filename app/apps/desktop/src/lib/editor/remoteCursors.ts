// Animated remote cursors + always-on name labels.
//
// `y-codemirror.next` renders each peer's caret as an *inline widget* sitting in
// the text flow, so every doc edit or peer move re-inserts it at a new offset —
// it teleports and can't be transitioned. We keep yCollab's selection highlight
// (mark decorations reflow fine) but hide its caret (see editor.css) and draw our
// own carets in a CodeMirror `layer()` instead: absolutely positioned elements
// moved with `transform`, so a CSS transition makes them glide between positions.
// Each caret carries a persistent name flag tinted with the peer's presence
// colour (the same `colorForUser` hue as their profile ring).

import { Annotation, type Extension } from "@codemirror/state";
import { EditorView, layer, ViewPlugin, type LayerMarker } from "@codemirror/view";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { insideFold } from "./folding";

/** Dispatched to nudge the layer into recomputing when awareness changes. */
const remoteCursorsSync = Annotation.define<boolean>();

/** A peer's caret at a resolved pixel position within the content. */
interface RemoteCursor {
  /** Awareness clientID — one caret per connected client (not per user). */
  clientId: number;
  left: number;
  top: number;
  height: number;
  color: string;
  name: string;
  /** Render the label below the caret instead of above (near the top edge). */
  flip: boolean;
}

/**
 * Content-relative origin of the layer, mirroring CodeMirror's internal
 * `getBase`. The desktop webview is LTR with no zoom transform, so scale is 1.
 */
function layerBase(view: EditorView): { left: number; top: number } {
  const rect = view.scrollDOM.getBoundingClientRect();
  return {
    left: rect.left - view.scrollDOM.scrollLeft,
    top: rect.top - view.scrollDOM.scrollTop,
  };
}

/** Resolve every remote peer's caret to on-screen coordinates. */
function readCursors(view: EditorView, ytext: Y.Text, awareness: Awareness): RemoteCursor[] {
  const ydoc = ytext.doc;
  if (!ydoc) return [];
  const base = layerBase(view);
  const cursors: RemoteCursor[] = [];
  awareness.getStates().forEach((state, clientId) => {
    if (clientId === awareness.clientID) return; // never draw our own caret
    const cursor = state.cursor;
    if (!cursor || cursor.head == null) return;
    const abs = Y.createAbsolutePositionFromRelativePosition(cursor.head, ydoc);
    if (!abs || abs.type !== ytext) return;
    // A caret inside a section WE have folded has no coordinates of its own —
    // `coordsAtPos` would answer with the placeholder's box, parking every
    // hidden peer's flag on top of the same `…` pill. Theirs is not our fold to
    // open, so the honest thing is to draw nothing.
    if (insideFold(view.state, abs.index)) return;
    const pos = view.coordsAtPos(abs.index);
    if (!pos) return; // off-screen (outside the rendered viewport) — skip
    const top = pos.top - base.top;
    const user = state.user ?? {};
    cursors.push({
      clientId,
      left: pos.left - base.left,
      top,
      height: pos.bottom - pos.top,
      color: typeof user.color === "string" ? user.color : "#30bced",
      name: typeof user.name === "string" && user.name ? user.name : "Someone",
      flip: top < 20, // too close to the top edge to fit the flag above
    });
  });
  // Stable order (by clientID) so the layer's positional reconciliation keeps
  // each client bound to its own DOM node across frames — that's what lets the
  // transition animate a move instead of swapping the element out.
  cursors.sort((a, b) => a.clientId - b.clientId);
  return cursors;
}

/** LayerMarker: one peer's caret bar + name flag, positioned via `transform`. */
class RemoteCaretMarker implements LayerMarker {
  constructor(readonly c: RemoteCursor) {}

  eq(other: LayerMarker): boolean {
    const o = (other as RemoteCaretMarker).c;
    const c = this.c;
    return (
      o != null &&
      o.clientId === c.clientId &&
      o.left === c.left &&
      o.top === c.top &&
      o.height === c.height &&
      o.color === c.color &&
      o.name === c.name &&
      o.flip === c.flip
    );
  }

  draw(): HTMLElement {
    const el = document.createElement("div");
    el.className = "cm-remoteCaret";
    const bar = document.createElement("div");
    bar.className = "cm-remoteCaret-bar";
    const label = document.createElement("div");
    label.className = "cm-remoteCaret-label";
    label.textContent = this.c.name;
    el.appendChild(bar);
    el.appendChild(label);
    this.adjust(el);
    return el;
  }

  update(dom: HTMLElement, prev: LayerMarker): boolean {
    const p = (prev as RemoteCaretMarker).c;
    // A different client — let the layer draw a fresh node rather than morph one
    // peer's caret into another's (which would animate across the whole doc).
    if (p == null || p.clientId !== this.c.clientId) return false;
    if (p.name !== this.c.name) {
      const label = dom.querySelector(".cm-remoteCaret-label");
      if (label) label.textContent = this.c.name;
    }
    this.adjust(dom);
    return true;
  }

  private adjust(el: HTMLElement): void {
    const c = this.c;
    el.style.setProperty("--rc", c.color);
    el.style.height = `${c.height}px`;
    el.style.transform = `translate(${c.left}px, ${c.top}px)`;
    el.classList.toggle("flip", c.flip);
  }
}

/**
 * Build the animated remote-cursor extension for a note's `Y.Text` + awareness.
 * Returns a ViewPlugin (redraws on awareness change) plus the drawing layer.
 */
export function remoteCursors(ytext: Y.Text, awareness: Awareness): Extension {
  const nudge = ViewPlugin.fromClass(
    class {
      private readonly onChange: (arg: {
        added: number[];
        updated: number[];
        removed: number[];
      }) => void;
      constructor(view: EditorView) {
        this.onChange = ({ added, updated, removed }) => {
          const changed = added.concat(updated).concat(removed);
          // Ignore transactions that only reflect our own cursor moving.
          if (changed.some((id) => id !== awareness.clientID)) {
            view.dispatch({ annotations: remoteCursorsSync.of(true) });
          }
        };
        awareness.on("change", this.onChange);
      }
      destroy() {
        awareness.off("change", this.onChange);
      }
    },
  );

  let scrollTimer: number | null = null;
  const cursorLayer = layer({
    above: true,
    class: "cm-remoteCaretLayer",
    update: (update) =>
      update.docChanged ||
      update.viewportChanged ||
      update.geometryChanged ||
      update.transactions.some((tr) => tr.annotation(remoteCursorsSync) !== undefined),
    markers: (view) => readCursors(view, ytext, awareness).map((c) => new RemoteCaretMarker(c)),
    mount: (dom, view) => {
      // Freeze the glide while scrolling so carets stay pinned to their text.
      const onScroll = () => {
        dom.classList.add("is-scrolling");
        if (scrollTimer != null) window.clearTimeout(scrollTimer);
        scrollTimer = window.setTimeout(() => dom.classList.remove("is-scrolling"), 120);
      };
      view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
      (dom as HTMLElement & { _onScroll?: () => void })._onScroll = onScroll;
    },
    destroy: (dom, view) => {
      const onScroll = (dom as HTMLElement & { _onScroll?: () => void })._onScroll;
      if (onScroll) view.scrollDOM.removeEventListener("scroll", onScroll);
      if (scrollTimer != null) window.clearTimeout(scrollTimer);
    },
  });

  return [nudge, cursorLayer];
}
