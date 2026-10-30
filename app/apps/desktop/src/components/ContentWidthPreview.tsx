import { useEffect, useRef, useState } from "react";
import { computePreviewColumn } from "../lib/editorMeasure";
import { useStore } from "../store";
import type { EditorMeasure } from "../lib/prefs";

/**
 * A live miniature of the editor pane, under the Content width slider.
 *
 * The point is that it is TRUE TO LIFE rather than decorative: it measures the
 * real editor pane and the real width of a character in the editor's font, runs
 * the same arithmetic the browser runs for `--editor-pad-x`
 * (`lib/editorMeasure.ts` `computePreviewColumn`), and scales the answer down.
 * So a window too narrow to grant the measure you are dragging towards shows
 * the column stop growing — which is the one thing a fixed illustration could
 * never tell you.
 */

/** The pane to assume when Settings is opened with no note (and so no editor)
 *  on screen: a typical window less the sidebar. The shape stays honest even
 *  though the scale is a guess. */
const FALLBACK_PANE_WIDTH = 960;
/** Fallback gutter, if `--editor-gutter` can't be read. Matches tokens.css. */
const FALLBACK_GUTTER_PX = 64;
/** More characters, less rounding error — the same probe trick the indent
 *  guides use to measure one indent unit (`lib/editor/indentGuides.ts`). */
const PROBE_CHARS = 20;
/** A sane `ch` for a browser that measures zero (a detached document). */
const FALLBACK_CH_PX = 9;
/** A sane editor font size for the same case. */
const FALLBACK_FONT_PX = 16;

/** Real words, not grey bars: the miniature sets them in the editor's font
 *  scaled by the same factor as the column, so they break where a real note
 *  would and the eye can judge the line length directly. */
const SAMPLE_TITLE = "Weekly planning";
const SAMPLE_TEXT =
  "Each Monday the team picks the three things that matter most this week and " +
  "writes them down here, so nobody has to ask twice. Decisions get a line of " +
  "context and a name, open questions get an owner, and anything that slips " +
  "moves to Friday's review with a short note on why it slipped.";

/**
 * The width of one `0` in the editor's body font — which is exactly what the
 * `ch` unit in `--editor-measure` means. It is NOT the settings panel's font,
 * and it is not the root font either: `ch` resolves at the element that uses
 * the token, and that element is `.cm-line`.
 */
function measureFont(): { chPx: number; fontPx: number } {
  const probe = document.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText =
    "position:absolute;top:0;left:-9999px;white-space:pre;visibility:hidden;" +
    "pointer-events:none;font-family:var(--editor-font-family, var(--font-body));" +
    "font-size:var(--editor-font-size, var(--fs-lg))";
  probe.textContent = "0".repeat(PROBE_CHARS);
  document.body.appendChild(probe);
  const width = probe.getBoundingClientRect().width / PROBE_CHARS;
  const fontPx = Number.parseFloat(getComputedStyle(probe).fontSize);
  probe.remove();
  return {
    chPx: width > 0 ? width : FALLBACK_CH_PX,
    fontPx: Number.isFinite(fontPx) && fontPx > 0 ? fontPx : FALLBACK_FONT_PX,
  };
}

function readGutterPx(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--editor-gutter");
  const px = Number.parseFloat(raw);
  return Number.isFinite(px) && px > 0 ? px : FALLBACK_GUTTER_PX;
}

/** What a `ch` is worth, and how much air the editor insists on at each edge.
 *  Neither can change while the panel is open: the font is a local woff2 loaded
 *  at startup and the gutter is a token. Measured once, off the resize path. */
interface Scale {
  chPx: number;
  fontPx: number;
  gutterPx: number;
}

interface Widths {
  paneWidth: number;
  previewWidth: number;
}

export function ContentWidthPreview({ measure }: { measure: EditorMeasure }) {
  const pageRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState<Scale | null>(null);
  const [widths, setWidths] = useState<Widths | null>(null);

  // Re-measured when the note font or size changes: `ch` is the width of a
  // character in THAT font at THAT size.
  const editorFont = useStore((s) => s.editorFont);
  const editorFontSize = useStore((s) => s.editorFontSize);
  useEffect(() => {
    setScale({ ...measureFont(), gutterPx: readGutterPx() });
  }, [editorFont, editorFontSize]);

  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    // The editor is behind the settings card, still laid out at its real width.
    const pane = document.querySelector<HTMLElement>(".editor-wrap");
    const read = () => {
      const measured = pane?.getBoundingClientRect().width ?? 0;
      const next = {
        paneWidth: measured > 0 ? measured : FALLBACK_PANE_WIDTH,
        previewWidth: page.clientWidth,
      };
      // A ResizeObserver fires for changes in either axis; re-rendering the
      // miniature because the card got taller would be pure noise.
      setWidths((prev) =>
        prev && prev.paneWidth === next.paneWidth && prev.previewWidth === next.previewWidth
          ? prev
          : next,
      );
    };
    read();
    // Both ends can change under us: the card is `94vw`, and the pane behind it
    // resizes with the window and with the sidebar's divider.
    const observer = new ResizeObserver(read);
    observer.observe(page);
    if (pane) observer.observe(pane);
    return () => observer.disconnect();
  }, []);

  const column =
    scale && widths
      ? computePreviewColumn({
          paneWidth: widths.paneWidth,
          gutterPx: scale.gutterPx,
          measurePx: measure === "full" ? "full" : scale.chPx * measure,
          previewWidth: widths.previewWidth,
        })
      : null;
  // Same factor computePreviewColumn shrinks the pane by, so the sample text
  // keeps its true characters-per-line inside the miniature column.
  const ratio =
    widths && widths.paneWidth > 0 ? widths.previewWidth / widths.paneWidth : 1;
  const charsPerLine =
    column && scale ? Math.round(column.columnPx / ratio / scale.chPx) : null;

  return (
    <div className="width-preview">
      <div className="width-preview-frame">
        {/* Decorative: the slider's readout already says what this shows. */}
        <div className="width-preview-page" ref={pageRef} aria-hidden="true">
          <div
            className="width-preview-col"
            style={
              column
                ? { width: `${column.columnPx}px`, marginInline: `${column.insetPx}px` }
                : // Before the first measurement, no bars rather than bars in
                  // the wrong place — the row is one frame old at most.
                  { width: 0, marginInline: "auto", visibility: "hidden" }
            }
          >
            <div
              className="width-preview-text"
              style={scale ? { fontSize: `${scale.fontPx * ratio}px` } : undefined}
            >
              <strong>{SAMPLE_TITLE}</strong>
              <p>{SAMPLE_TEXT}</p>
            </div>
          </div>
        </div>
      </div>
      <span className="field-hint width-preview-caption">
        {charsPerLine != null
          ? `${measure === "full" ? "Full width, about" : "About"} ${charsPerLine} characters per line in this window.`
          : "About how a note will sit in your window."}
      </span>
    </div>
  );
}
