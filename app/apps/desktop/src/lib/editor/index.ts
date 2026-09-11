// Editor factory. Builds the CodeMirror 6 extension set for a markdown note.
// Designed so Phase 1 can append a Yjs `y-codemirror.next` binding to
// `extraExtensions` without changing any callsite.

import { autocompletion, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { indentOnInput } from "@codemirror/language";
import { searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  keymap,
} from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import type { NoteTitle } from "../ipc";
import { blockDecorations } from "./blocks";
import { codeFenceFlair } from "./codeFence";
import { codeLanguages } from "./codeLanguages";
import { formattingKeymap } from "./formatting";
import { frontmatterDecorations } from "./frontmatter";
import { listKeymap } from "./lists";
import { livePreview } from "./livePreview";
import { noteHeader, type NoteHeaderOptions } from "./noteHeader";
import { ofmDecorations, ofmMarkdown } from "./ofm";
import { smartPaste, type SaveAttachment } from "./paste";
import { tableAtomicRanges } from "./table/atomic";
import { tripleClickLine } from "./selection";
import { slashCompletions } from "./slash";
import { checkboxes } from "./tasks";
import { editorTheme, markdownHighlight } from "./theme";
import { wikilinkCompletions, wikilinks } from "./wikilinks";

export interface CreateEditorOptions {
  doc: string;
  getTitles: () => NoteTitle[];
  onNavigate: (target: string) => void;
  /** Phase-0 buffer callback; omitted for CRDT-managed notes (yCollab syncs). */
  onChange?: (doc: string) => void;
  /** Later phases (Yjs binding) append here. */
  extraExtensions?: Extension[];
  /**
   * Turn an image `src` from a note into a URL the webview can load. Local
   * vault paths become `asset:` URLs (via convertFileSrc); http/data URLs pass
   * through. Omitted → images render with their raw `src`.
   */
  resolveAsset?: (src: string) => string;
  /**
   * Persist pasted/dropped image bytes into the vault and return the markdown
   * `src` to embed. Omitted → image paste/drop falls back to default handling.
   */
  saveAttachment?: SaveAttachment;
  /**
   * When true, a Yjs `y-codemirror.next` binding (passed via extraExtensions)
   * owns change propagation and undo history, so we drop CM6's local
   * `history()` + its keymap and the buffer `onChange` listener (spec 03 §5).
   */
  collab?: boolean;
  /**
   * The inline title + Properties panel above the body. Omitted for editors
   * with no note behind them — the version-preview view and the tests — which
   * then keep the plain dimmed frontmatter block.
   */
  header?: NoteHeaderOptions;
}

export function baseExtensions(opts: CreateEditorOptions): Extension[] {
  const collab = opts.collab ?? false;
  const keys = [
    ...closeBracketsKeymap,
    ...defaultKeymap,
    // CRDT notes use the Yjs UndoManager keymap (added via extraExtensions);
    // the local CM6 history keymap would fight it, so drop it in collab mode.
    ...(collab ? [] : historyKeymap),
    ...searchKeymap,
  ];

  return [
    // Local history only for the non-CRDT path; yCollab supplies undo otherwise.
    ...(collab ? [] : [history()]),
    drawSelection(),
    // Triple-click selects a line's content without its trailing newline, so
    // the selection highlight doesn't bleed onto the next line.
    tripleClickLine,
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    EditorView.lineWrapping,
    closeBrackets(),
    // Markdown-aware editing keys, ahead of the base keymap so they win:
    //   Mod-b/i/e/k/…  inline formatting toggles
    //   Enter / Tab    smart list & quote continuation / indent
    formattingKeymap(),
    listKeymap(),
    keymap.of(keys),
    // One autocompletion surface, shared by the slash-command block menu and
    // the [[wiki-link]] source (two `autocompletion()` configs would conflict).
    autocompletion({
      override: [
        slashCompletions,
        wikilinkCompletions({ getTitles: opts.getTitles, onNavigate: opts.onNavigate }),
      ],
    }),
    // GFM adds tables, task lists, strikethrough, and autolinks; `ofmMarkdown`
    // adds Obsidian's `==highlight==`, `%%comment%%` and `#tag` on top, so a
    // vault reads the same here and in Obsidian.
    // `codeLanguages` are LanguageDescriptions with dynamic imports: nothing
    // here reaches the startup bundle, and a grammar is fetched only when a
    // fence in an open note claims that language.
    markdown({
      base: markdownLanguage,
      extensions: [GFM, ...ofmMarkdown],
      codeLanguages,
    }),
    markdownHighlight,
    // Frontmatter first: blocks.ts and livePreview.ts both read its range so
    // nothing else decorates inside it (see lib/editor/frontmatter.ts).
    frontmatterDecorations,
    // The inline title and the Properties panel. After frontmatterDecorations,
    // which yields the region to it (one authority: `frontmatterView`).
    ...(opts.header ? [noteHeader(opts.header)] : []),
    blockDecorations,
    // Live-preview inline rendering: hide markers off the active line, render
    // bullets/links/images/tables, and preview embedded HTML blocks (never run).
    livePreview({ resolveAsset: opts.resolveAsset, onNavigate: opts.onNavigate }),
    // A table is always rendered, so the caret must never walk into one.
    tableAtomicRanges,
    // Clickable `- [ ]` task checkboxes.
    checkboxes,
    // A copy button on every code fence.
    codeFenceFlair,
    // Paste a URL over a selection → link; paste/drop an image → attachment.
    smartPaste(opts.saveAttachment),
    editorTheme,
    wikilinks({ getTitles: opts.getTitles, onNavigate: opts.onNavigate }),
    // Callout tinting + tag pills. After livePreview, whose QuoteMark rule
    // hides the `>` a callout's marker line still carries.
    ...ofmDecorations,
    // Only mirror doc changes into the store buffer for the Phase-0 path.
    ...(collab || !opts.onChange
      ? []
      : [
          EditorView.updateListener.of((u) => {
            if (u.docChanged) opts.onChange!(u.state.doc.toString());
          }),
        ]),
    ...(opts.extraExtensions ?? []),
  ];
}

export function createEditorState(opts: CreateEditorOptions): EditorState {
  return EditorState.create({ doc: opts.doc, extensions: baseExtensions(opts) });
}
