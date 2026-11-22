// Plain-words notes on sync-rule lines that can never do anything (#401).
//
// A rule can hide any path and bring a path back with `!`, but it can never
// turn on a file type Baalda doesn't support: that type has no viewer, no size
// class and no server MIME, so syncing it would break things. A `!` line whose
// pattern names such a type is therefore a no-op, and the editor says so.

import { OPT_IN_EXTS, SURFACED_EXTS } from "../formats";

const SUPPORTED = new Set(SURFACED_EXTS.map((e) => e.toLowerCase()));
/** Types a switch below the editor turns on: a `!` line can't, but the switch can. */
const SWITCHABLE = new Map<string, string>([
  ...OPT_IN_EXTS.code.map((e): [string, string] => [e, "Code and text files"]),
  ...OPT_IN_EXTS.extra.map((e): [string, string] => [e, "More file types"]),
]);

export interface LineNote {
  /** 1-based line number. */
  line: number;
  message: string;
}

export function unsupportedLines(
  patterns: string,
  types: { code: boolean; extra: boolean } = { code: false, extra: false },
): LineNote[] {
  const out: LineNote[] = [];
  patterns.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line.startsWith("!")) return;
    // The last segment's extension, when it names one literally (`!*.exe`,
    // `!build/app.exe`). Wildcards inside the extension say nothing.
    const last = line.slice(1).replace(/\/+$/, "").split("/").pop() ?? "";
    const m = /\.([A-Za-z0-9]+)$/.exec(last);
    if (!m) return;
    const ext = m[1].toLowerCase();
    if (SUPPORTED.has(ext)) return;
    const group = SWITCHABLE.get(ext);
    if (group === "Code and text files" && types.code) return;
    if (group === "More file types" && types.extra) return;
    if (group) {
      out.push({
        line: i + 1,
        message: `This line can't turn on .${ext} files; switch on "${group}" below instead.`,
      });
      return;
    }
    out.push({ line: i + 1, message: `Baalda can't sync .${ext} files, so this line has no effect.` });
  });
  return out;
}
