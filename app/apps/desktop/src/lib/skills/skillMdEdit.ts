// SKILL.md's header in the draft editor: split the frontmatter from the body,
// and change `description` as ONE span replacement inside the frontmatter, so
// every other key, comment and the key order stay byte for byte (the Properties
// panel's rule for notes, `lib/frontmatter/edit.ts`). Pure, pinned by
// `__tests__/skillMdEdit.test.ts`.

import { readFrontmatterFields } from "./validate";

export interface SkillMdParts {
  /** Both `---` lines and everything between, with the closing line's newline. */
  frontmatter: string;
  body: string;
}

/** Split at the closing `---`; null when the text doesn't open with a frontmatter block. */
export function splitSkillMd(text: string): SkillMdParts | null {
  if (!/^(﻿)?---\r?\n/.test(text)) return null;
  const open = text.startsWith("\uFEFF") ? 4 : 3;
  const close = /\n---[ \t]*(\r?\n|$)/.exec(text.slice(open));
  if (!close) return null;
  const end = open + close.index + close[0].length;
  return { frontmatter: text.slice(0, end), body: text.slice(end) };
}

export interface SkillHeader {
  parts: SkillMdParts;
  name: string | null;
  description: string | null;
}

/** The header the editor shows, or null when the frontmatter can't be read (raw mode). */
export function readSkillHeader(text: string): SkillHeader | null {
  const parts = splitSkillMd(text);
  if (!parts) return null;
  const fields = readFrontmatterFields(parts.frontmatter);
  if ("reason" in fields) return null;
  return { parts, name: fields.name, description: fields.description };
}

const NON_STRING_PLAIN = /^(~|null|true|false|yes|no|on|off|y|n|[-+]?(\d[\d_]*)(\.\d*)?([eE][-+]?\d+)?|[-+]?\.(inf|nan)|0x[0-9a-f]+|0o[0-7]+)$/i;

/** `value` as a YAML scalar that reads back as exactly that string. */
export function yamlScalar(value: string, eol = "\n"): string {
  if (value.includes("\n")) {
    const lines = value.split("\n").map((l) => (l ? `  ${l}` : ""));
    // `|-` drops the final newline; a value ending in one keeps it with `|`.
    return value.endsWith("\n") ? `|${eol}${lines.slice(0, -1).join(eol)}` : `|-${eol}${lines.join(eol)}`;
  }
  const plain =
    value !== "" &&
    !/^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(value) &&
    !/\s$/.test(value) &&
    !/:(\s|$)/.test(value) &&
    !/\s#/.test(value) &&
    !NON_STRING_PLAIN.test(value);
  return plain ? value : JSON.stringify(value);
}

/**
 * `frontmatter` with `description` set to `value`: the existing entry (its key
 * line and any indented continuation) is replaced in place, or a new line goes
 * after `name` (else before the closing `---`). Null when the block can't be read.
 */
export function setFrontmatterDescription(frontmatter: string, value: string): string | null {
  if ("reason" in readFrontmatterFields(frontmatter)) return null;
  const eol = frontmatter.includes("\r\n") ? "\r\n" : "\n";
  const lines = frontmatter.split("\n");
  // Line starts in `frontmatter`; the last element is "" after the final newline.
  const starts: number[] = [];
  let at = 0;
  for (const l of lines) {
    starts.push(at);
    at += l.length + 1;
  }
  const close = lines.findIndex((l, i) => i > 0 && l.replace(/\r$/, "").trimEnd() === "---");
  if (close < 0) return null;
  const isKey = (i: number) => i > 0 && i < close && /^[^\s#]/.test(lines[i]);
  const keyOf = (i: number) => /^("[^"]*"|'[^']*'|[^\s#:][^:]*?)\s*:/.exec(lines[i])?.[1].replace(/^["']|["']$/g, "");
  const entry = (key: string) => {
    for (let i = 1; i < close; i++) if (isKey(i) && keyOf(i) === key) return i;
    return -1;
  };
  const line = `description: ${yamlScalar(value, eol)}${eol}`;

  const d = entry("description");
  if (d >= 0) {
    // The entry runs to the next key or the closing line; trailing blank and
    // comment lines stay outside it.
    let last = d;
    for (let i = d + 1; i < close && !isKey(i); i++) {
      if (lines[i].trim() !== "" && !/^\s*#/.test(lines[i])) last = i;
    }
    return frontmatter.slice(0, starts[d]) + line + frontmatter.slice(starts[last + 1]);
  }
  const n = entry("name");
  let insertAt = close;
  if (n >= 0) {
    insertAt = n + 1;
    while (insertAt < close && !isKey(insertAt) && lines[insertAt].trim() !== "") insertAt++;
  }
  return frontmatter.slice(0, starts[insertAt]) + line + frontmatter.slice(starts[insertAt]);
}
