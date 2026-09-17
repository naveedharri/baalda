// Which glyph a sidebar row gets, derived from the format registry rather than
// from a second list of extensions.
//
// Split out of `components/FileTree.tsx` so the mapping is a pure function with
// a test of its own: the icons themselves are JSX and live with the component,
// but "what KIND of thing is this file" is the registry's answer and the thing
// that can silently go wrong (a `.mp4` drawn as a page, a `.zip` as a note).

import { formatFor } from "./formats";

/** The glyph slots `FileTree` draws. `file` is the default page icon. */
export type TreeIconKey =
  | "file"
  | "html"
  | "image"
  | "pdf"
  | "sheet"
  | "doc"
  | "slides"
  | "media"
  | "archive"
  | "code";

/**
 * The icon key for a file path.
 *
 * Category first, because that is the family a reader recognises; the `data`
 * category is the one exception — it holds both tabular files and source text,
 * which look nothing alike in a sidebar — so it asks the VIEWER instead. Notes
 * keep the plain page icon (they are the default thing in a vault, and a
 * special glyph for the common case is noise), and `.html`/`.htm` keep the
 * code-page glyph they have always had, which is what tells a rendered page
 * apart from a note.
 */
export function iconKeyForPath(path: string): TreeIconKey {
  const format = formatFor(path);
  if (!format) return "file";
  switch (format.category) {
    case "note":
      return "file";
    case "text":
      return format.viewer === "html" ? "html" : "file";
    case "image":
      return "image";
    case "pdf":
      return "pdf";
    case "office-doc":
      return "doc";
    case "spreadsheet":
      return "sheet";
    case "presentation":
      return "slides";
    case "audio":
    case "video":
      return "media";
    case "archive":
      return "archive";
    case "data":
      return format.viewer === "csv" ? "sheet" : "code";
    default:
      return "file";
  }
}
