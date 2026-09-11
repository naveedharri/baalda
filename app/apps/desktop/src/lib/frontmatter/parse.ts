/**
 * A deliberately narrow YAML reader for note frontmatter — flat maps only, with
 * doc-absolute spans for every token.
 *
 * Why not the `yaml` package: the Properties panel only ever renders a flat map,
 * so anything nested has to be detected and refused regardless; a general parser
 * buys expressive power we then throw away, for ~25-30 KB gzipped on a bundle
 * the last release halved. And agreement with Rust matters more than generality
 * here: `notes.frontmatter` comes from `serde_yaml` (`src-tauri/src/parse.rs`),
 * and two independent full parsers can disagree at the edges. A subset that
 * REFUSES everything it does not recognise cannot — refusal is the safe
 * direction, because a refusal shows the raw YAML and never rewrites the file.
 *
 * The deliverable is the spans, not the values. Every edit the panel makes is a
 * minimal replacement of one span (see `./edit.ts`), so editing `status` cannot
 * reformat `tags`, drop a comment, or reorder keys.
 *
 * `valueSpan` starts immediately after the key's `:` and INCLUDES the separator
 * whitespace (or the newline before a block list). That is what lets one
 * serializer handle `key: v`, `key: [a, b]`, `key:\n  - a` and the empty `key:`
 * without any of them sniffing the surrounding bytes.
 */

import type { Text } from "@codemirror/state";
import type { FrontmatterRange } from "../editor/frontmatter";

export type PropValue =
  | { kind: "text"; value: string }
  | { kind: "number"; value: number }
  | { kind: "checkbox"; value: boolean }
  | { kind: "date"; value: string } // YYYY-MM-DD
  | { kind: "datetime"; value: string } // ISO 8601
  | { kind: "list"; value: string[] };

export interface Span {
  from: number;
  to: number;
}

export interface PropEntry {
  key: string;
  /** Span of the key token, doc-absolute (no quotes, no colon). */
  keySpan: Span;
  /** Span of the whole logical line(s) — what a delete removes. */
  lineSpan: Span;
  /** Span from just after the `:` to the end of the value — what an edit
   *  replaces. Includes the separator space / newline (see the module note). */
  valueSpan: Span;
  value: PropValue;
  /** Original serialization of `valueSpan`, so an unchanged round-trip writes
   *  nothing and a concurrent edit can be spotted on commit. */
  raw: string;
  /** Flow `[a, b]` vs block `- a`, so an edit re-serializes in the same style. */
  listStyle?: "flow" | "block";
  /** Indent the block list's items already use, so an edit matches it. */
  listIndent?: string;
}

export type ParseFailure =
  | "nested"
  | "unsupported-scalar"
  | "duplicate-key"
  | "malformed";

export type ParseResult =
  | { ok: true; entries: PropEntry[] }
  | { ok: false; reason: ParseFailure };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;
// Leading zeros stay text: `007` is a code, not the number seven, and turning it
// into one would silently rewrite the file on the next edit.
const NUMBER_RE = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

/** Sigils that start a YAML construct we refuse to render or rewrite. */
const REFUSED_SIGILS = "|>&*!";

/** Strip the CR of a CRLF document so every span stays byte-accurate. */
function bodyOf(text: string): string {
  return text.endsWith("\r") ? text.slice(0, -1) : text;
}

/** Where an unquoted value ends: at a ` #` comment, or at the line's end. */
function unquotedEnd(text: string, start: number): number {
  for (let i = start; i < text.length; i++) {
    if (text[i] === "#" && (i === start || /\s/.test(text[i - 1]!))) return i;
  }
  return text.length;
}

/** End index (exclusive) of a quoted scalar starting at `start`, or -1. */
function quotedEnd(text: string, start: number): number {
  const q = text[start];
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (q === '"' && c === "\\") {
      i++;
      continue;
    }
    if (c === q) {
      // A doubled single quote is an escaped quote, not the end.
      if (q === "'" && text[i + 1] === "'") {
        i++;
        continue;
      }
      return i + 1;
    }
  }
  return -1;
}

/** End index (exclusive) of a flow sequence starting at `[`, or -1. */
function flowEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'") {
      const end = quotedEnd(text, i);
      if (end === -1) return -1;
      i = end - 1;
      continue;
    }
    if (c === "]") return i + 1;
    if (c === "[" || c === "{") return -1; // nested collections are refused
  }
  return -1;
}

/** Undo YAML quoting for display. Only the escapes we can round-trip. */
export function unquote(token: string): string {
  if (token.length >= 2 && token[0] === '"' && token.endsWith('"')) {
    return token
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\(["\\/])/g, "$1");
  }
  if (token.length >= 2 && token[0] === "'" && token.endsWith("'")) {
    return token.slice(1, -1).replace(/''/g, "'");
  }
  return token;
}

/** Split a flow sequence's body into its member tokens. */
function splitFlow(body: string): string[] | null {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === '"' || c === "'") {
      const end = quotedEnd(body, i);
      if (end === -1) return null;
      cur += body.slice(i, end);
      i = end - 1;
      continue;
    }
    if (c === ",") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  const items = out.map((s) => unquote(s.trim()));
  // `[]` is the empty list, not a list of one empty string.
  if (items.length === 1 && items[0] === "") return [];
  return items;
}

/** Classify one scalar token. `null` = a shape we refuse to touch. */
function classify(token: string): PropValue | null {
  if (token === "") return { kind: "text", value: "" };
  const first = token[0]!;
  // Block scalars, anchors/aliases and tags: mirrors the Rust sigil guard.
  if (REFUSED_SIGILS.includes(first)) return null;
  if (first === '"' || first === "'") return { kind: "text", value: unquote(token) };
  if (token === "true" || token === "false") {
    return { kind: "checkbox", value: token === "true" };
  }
  if (NUMBER_RE.test(token)) {
    const n = Number(token);
    if (Number.isFinite(n)) return { kind: "number", value: n };
  }
  if (DATE_RE.test(token)) return { kind: "date", value: token };
  if (DATETIME_RE.test(token)) return { kind: "datetime", value: token };
  return { kind: "text", value: token };
}

/**
 * Parse the frontmatter region into flat entries with doc-absolute spans.
 * Anything outside the supported subset resolves to `{ ok: false }`, which the
 * panel renders as a banner over the untouched source.
 */
export function parseFrontmatter(doc: Text, fm: FrontmatterRange): ParseResult {
  const entries: PropEntry[] = [];
  const seen = new Set<string>();
  let pending: PropEntry | null = null;
  /** Items accumulated for `pending` from `- item` lines. */
  let pendingItems: string[] = [];

  const flush = () => {
    if (!pending) return;
    if (pending.listStyle === "block") {
      pending.value = { kind: "list", value: pendingItems };
      pending.raw = doc.sliceString(pending.valueSpan.from, pending.valueSpan.to);
    }
    entries.push(pending);
    pending = null;
    pendingItems = [];
  };

  for (let n = fm.openLine + 1; n < fm.closeLine; n++) {
    const line = doc.line(n);
    const text = bodyOf(line.text);
    if (text.trim() === "") continue;
    // A tab anywhere in the indentation is a YAML error, and tab-vs-space
    // guessing is exactly the sort of disagreement with serde_yaml we refuse.
    const indent = /^[ \t]*/.exec(text)![0];
    if (indent.includes("\t")) return { ok: false, reason: "malformed" };
    const rest = text.slice(indent.length);
    if (rest.startsWith("#")) continue; // comment line

    // A `- item` line continues the pending key's block list.
    if (rest === "-" || rest.startsWith("- ")) {
      if (!pending) return { ok: false, reason: "malformed" };
      if (pending.listStyle === "flow") return { ok: false, reason: "malformed" };
      const itemText = rest === "-" ? "" : rest.slice(2).trim();
      const end =
        itemText.startsWith('"') || itemText.startsWith("'")
          ? quotedEnd(itemText, 0)
          : unquotedEnd(itemText, 0);
      if (end === -1) return { ok: false, reason: "malformed" };
      const token = itemText.slice(0, end).trim();
      if (token !== "" && REFUSED_SIGILS.includes(token[0]!)) {
        return { ok: false, reason: "unsupported-scalar" };
      }
      if (token.startsWith("{")) return { ok: false, reason: "nested" };
      if (token.includes(": ") || /:$/.test(token)) {
        return { ok: false, reason: "nested" };
      }
      pending.listStyle = "block";
      pending.listIndent = indent;
      pendingItems.push(unquote(token));
      pending.lineSpan.to = line.to;
      pending.valueSpan.to = line.to;
      continue;
    }

    // Anything else indented under a key is a nested mapping.
    if (indent.length > 0) return { ok: false, reason: "nested" };
    if (rest === "..." || rest === "---") return { ok: false, reason: "malformed" };

    flush();

    // `key: …`. The key may be quoted; a bare key runs to the first colon.
    let keyEnd: number;
    if (rest[0] === '"' || rest[0] === "'") {
      const q = quotedEnd(rest, 0);
      if (q === -1) return { ok: false, reason: "malformed" };
      keyEnd = q;
    } else {
      keyEnd = rest.indexOf(":");
      if (keyEnd === -1) return { ok: false, reason: "malformed" };
    }
    const keyToken = rest.slice(0, keyEnd).trim();
    if (keyToken === "") return { ok: false, reason: "malformed" };
    const afterKey = rest.slice(keyEnd);
    const colon = afterKey.indexOf(":");
    if (colon === -1) return { ok: false, reason: "malformed" };
    if (afterKey.slice(0, colon).trim() !== "") return { ok: false, reason: "malformed" };
    const key = unquote(keyToken);
    if (seen.has(key)) return { ok: false, reason: "duplicate-key" };
    seen.add(key);

    // Doc-absolute offsets. `line.from + indent.length` is where `rest` starts.
    const restFrom = line.from + indent.length;
    const quotedKey = rest[0] === '"' || rest[0] === "'";
    const keyFrom = restFrom + (quotedKey ? 1 : 0);
    const keySpan = { from: keyFrom, to: keyFrom + key.length };
    const valueFrom = restFrom + keyEnd + colon + 1;
    const tail = rest.slice(keyEnd + colon + 1);
    const tailStart = /^ */.exec(tail)![0].length;
    const token0 = tail.slice(tailStart);

    let valueTo = line.to;
    let value: PropValue;
    let listStyle: "flow" | "block" | undefined;

    if (token0 === "" || token0.startsWith("#")) {
      // `key:` — an empty value, or a key whose block list follows below. The
      // span runs to the line's end so a later edit absorbs any stray trailing
      // whitespace instead of writing `key:   value`. A trailing comment is
      // preserved by stopping the span right after the colon.
      value = { kind: "text", value: "" };
      valueTo = token0.startsWith("#") ? valueFrom : line.to;
    } else if (token0.startsWith("[")) {
      const end = flowEnd(token0, 0);
      if (end === -1) return { ok: false, reason: "malformed" };
      const items = splitFlow(token0.slice(1, end - 1));
      if (items === null) return { ok: false, reason: "malformed" };
      value = { kind: "list", value: items };
      listStyle = "flow";
      valueTo = valueFrom + tailStart + end;
    } else if (token0.startsWith("{")) {
      return { ok: false, reason: "nested" };
    } else {
      const end =
        token0[0] === '"' || token0[0] === "'"
          ? quotedEnd(token0, 0)
          : unquotedEnd(token0, 0);
      if (end === -1) return { ok: false, reason: "malformed" };
      const token = token0.slice(0, end).trimEnd();
      const classified = classify(token);
      if (!classified) return { ok: false, reason: "unsupported-scalar" };
      value = classified;
      valueTo = valueFrom + tailStart + token.length;
    }

    pending = {
      key,
      keySpan,
      lineSpan: { from: line.from, to: line.to },
      valueSpan: { from: valueFrom, to: valueTo },
      value,
      raw: doc.sliceString(valueFrom, valueTo),
      ...(listStyle ? { listStyle } : {}),
    };
  }
  flush();
  return { ok: true, entries };
}

/** One-line display text for a value (the panel's text/number/date inputs). */
export function valueToText(v: PropValue): string {
  if (v.kind === "list") return v.value.join(", ");
  if (v.kind === "checkbox") return v.value ? "true" : "false";
  return String(v.value);
}
