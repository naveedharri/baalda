/**
 * React inside a CodeMirror block widget.
 *
 * Extracted from `noteHeader.ts`, where the contract was first worked out for
 * the inline title and the Properties panel, and now shared with the editable
 * table widget. The three rules below are the whole reason a React tree can
 * live inside `.cm-content` at all:
 *
 * `flushSync` in `toDOM` is legal — we are inside a CM6 DOM-update callback,
 * not a React render phase — and it is what guarantees CM6 measures the real
 * height on the first frame instead of the estimate.
 *
 * `updateDOM` returning TRUE is the line the whole collaboration story hangs
 * on: CM6 keeps the host node, React reconciles into it, and the focused
 * `<input>` is the same DOM element before and after a remote keystroke. If it
 * ever returned false, CM6 would destroy and rebuild, and focus would be gone.
 *
 * `ignoreEvent()` returning TRUE stops `eventBelongsToEditor` at the host, so
 * NO editor keymap, mousedown, paste or input handler fires while the focus is
 * inside. Real `<input>`s (never a nested contenteditable) emit no
 * MutationRecords, so CM6's DOMObserver never force-flushes the widget's DOM
 * out from under the caret.
 */

import type { EditorView } from "@codemirror/view";
import { WidgetType } from "@codemirror/view";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";

const roots = new WeakMap<HTMLElement, Root>();

export abstract class ReactWidget extends WidgetType {
  /**
   * The tree to render. `host` is the widget's own DOM node — a component that
   * needs its document position asks the view for it (`view.posAtDOM(host)`)
   * at EVENT time, never at render time: CM6 reuses a widget's DOM across
   * document changes, so any offset captured during a render goes stale.
   */
  protected abstract render(view: EditorView, host: HTMLElement): ReactNode;
  protected abstract hostClass(): string;

  toDOM(view: EditorView): HTMLElement {
    const host = document.createElement("div");
    host.className = this.hostClass();
    const root = createRoot(host);
    roots.set(host, root);
    flushSync(() => root.render(this.render(view, host)));
    return host;
  }

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const root = roots.get(dom);
    if (!root) return false; // no root to reconcile into — let CM6 rebuild
    // Synchronous, like the first paint: a teammate's edit has to land in the
    // same frame as the document change, and CM6 measures this widget's height
    // right after the update — an async render would measure the old one. We
    // are inside a CM6 DOM-update callback, not a React render phase, so this
    // is a legal place to flush.
    flushSync(() => root.render(this.render(view, dom)));
    return true;
  }

  destroy(dom: HTMLElement): void {
    const root = roots.get(dom);
    roots.delete(dom);
    // React refuses an unmount during render; defer it past this update.
    if (root) queueMicrotask(() => root.unmount());
  }

  ignoreEvent(): boolean {
    return true;
  }
}
