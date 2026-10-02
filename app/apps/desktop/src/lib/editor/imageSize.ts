// Image width in the alt text, the Obsidian way (#244): `![alt|400](src)`.
//
// Pure, so the parse and the write-back plan are unit-tested without a view.
// The width lives in the markdown itself — plain text that round-trips through
// the `.md`, the CRDT and Obsidian unchanged — and a resize writes back ONE
// minimal span: the digits of the size segment, or a `|N` inserted at the end
// of the alt text. Nothing else in the note is ever rewritten.

/** Smallest and largest width a drag may write, in CSS pixels. */
export const MIN_IMAGE_WIDTH = 32;
export const MAX_IMAGE_WIDTH = 4000;

/** `alt|400` or `alt|400x300` (Obsidian accepts both; height is ignored here). */
const SIZE_RE = /\|\s*(\d{1,5})(?:\s*x\s*\d{1,5})?\s*$/;

export interface ParsedImageAlt {
  /** The alt text with the size segment removed — what the user reads. */
  alt: string;
  /** The requested width in px, or null when the alt names none. */
  width: number | null;
  /**
   * The width digits' offsets WITHIN the raw alt, when present — the only span
   * a resize replaces.
   */
  digits: { from: number; to: number } | null;
}

export function parseImageAlt(raw: string): ParsedImageAlt {
  const m = SIZE_RE.exec(raw);
  if (!m) return { alt: raw, width: null, digits: null };
  const width = Number(m[1]);
  if (!Number.isFinite(width) || width <= 0) return { alt: raw, width: null, digits: null };
  const digitsFrom = m.index + m[0].indexOf(m[1]);
  return {
    alt: raw.slice(0, m.index).trimEnd(),
    width,
    digits: { from: digitsFrom, to: digitsFrom + m[1].length },
  };
}

/** Round and clamp a dragged width to something worth writing. */
export function normalizeImageWidth(px: number): number {
  if (!Number.isFinite(px)) return MIN_IMAGE_WIDTH;
  return Math.min(MAX_IMAGE_WIDTH, Math.max(MIN_IMAGE_WIDTH, Math.round(px)));
}

/**
 * Where the alt text of the image starting at `imageFrom` sits in `text`
 * (`text` = the document from `imageFrom` on, or at least the image itself).
 * Null when the slice does not start with `![…]`, i.e. the doc moved on under
 * the widget — the caller then writes nothing.
 */
export function imageAltRange(text: string, imageFrom: number): { from: number; to: number; raw: string } | null {
  const m = /^!\[([^\]\n]*)\]\(/.exec(text);
  if (!m) return null;
  return { from: imageFrom + 2, to: imageFrom + 2 + m[1].length, raw: m[1] };
}

/**
 * The single change that sets the image's width to `width`, given the alt
 * span's doc offsets and raw text. Null when the width is unchanged — a
 * no-op drag never touches the document.
 */
export function planImageWidthChange(
  alt: { from: number; to: number; raw: string },
  width: number,
): { from: number; to: number; insert: string } | null {
  const next = normalizeImageWidth(width);
  const parsed = parseImageAlt(alt.raw);
  if (parsed.width === next) return null;
  if (parsed.digits) {
    return {
      from: alt.from + parsed.digits.from,
      to: alt.from + parsed.digits.to,
      insert: String(next),
    };
  }
  return { from: alt.to, to: alt.to, insert: `|${next}` };
}
