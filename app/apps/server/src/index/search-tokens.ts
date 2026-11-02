import { tokenize } from "./embedder.js";

/** Upper bound on a stored token set, in UTF-16 code units (all ASCII here). */
export const SEARCH_TOKENS_MAX = 64 * 1024;
/**
 * The bound for a keyed row's token set, which lives only inside its sealed
 * blobs and is matched in app memory: the 64 KB bound serves the plaintext
 * column and its SQL fallback. A note past 64 KB of distinct words otherwise
 * had every worded search open its whole sealed body (140 notes, 111 MB per
 * search on one vault, 2026-11-02).
 */
export const SEALED_TOKENS_MAX = 1024 * 1024;

/**
 * Characters whose lowercase may differ between JS `toLowerCase()` and
 * Postgres `lower()` in a way that changes the `[a-z0-9_]` runs a query token
 * can match: every non-ASCII code point whose JS lowercase contains an ASCII
 * letter, digit or underscore (U+0130 "İ" → "i\u0307", U+212A Kelvin → "k",
 * computed at load so no case is missed), checked with the `u` flag. Postgres
 * maps these through the database collation (glibc / ICU / C), which can give
 * a different run, so a text containing one is left to the old SQL path. All
 * other non-ASCII characters lower to non-ASCII in both and act as separators
 * in both, so they are safe. Query tokens are shared by both paths (JS
 * `tokenize`, ASCII by construction), so only the stored side needs this.
 */
const UNSAFE_LOWER: ReadonlySet<number> = (() => {
  const set = new Set<number>([0x130, 0x212a]);
  for (let cp = 0x80; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    if (/[a-z0-9_]/.test(String.fromCodePoint(cp).toLowerCase())) set.add(cp);
  }
  return set;
})();

/** True when `text` holds a character whose lowercase JS and Postgres may disagree on. */
export function hasUnsafeLowercase(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) continue;
    const cp = text.codePointAt(i)!;
    if (cp > 0xffff) i++;
    if (UNSAFE_LOWER.has(cp)) return true;
  }
  return false;
}

/**
 * The derived keyword set search scores against instead of reading note text in
 * SQL: unique `tokenize()` output in first-seen order, joined by single spaces.
 * A query token (always `[a-z0-9_]+`) is a substring of `lower(text)` exactly
 * when it is a substring of one maximal `[a-z0-9_]` run, i.e. of one token, so
 * `set.includes(q)` reproduces the old `position(q IN lower(text)) > 0` (the
 * space separator is outside the alphabet and can never be part of a match).
 *
 * Returns NULL — the row keeps the old SQL path, so search never misses what it
 * finds today — when the set would pass {@link SEARCH_TOKENS_MAX}, or when the
 * text holds a character {@link hasUnsafeLowercase} flags.
 */
export function searchTokenSet(text: string, max = SEARCH_TOKENS_MAX): string | null {
  if (hasUnsafeLowercase(text)) return null;
  const seen = new Set<string>();
  const parts: string[] = [];
  let len = 0;
  for (const t of tokenize(text)) {
    if (seen.has(t)) continue;
    seen.add(t);
    len = parts.length === 0 ? t.length : len + 1 + t.length;
    if (len > max) return null;
    parts.push(t);
  }
  return parts.join(" ");
}

/** {@link searchTokenSet} for a keyed row's sealed blobs, up to {@link SEALED_TOKENS_MAX}. */
export function sealedTokenSet(text: string): string | null {
  return searchTokenSet(text, SEALED_TOKENS_MAX);
}

/** How many of the (unique) query tokens occur in a stored token set. */
export function keywordMatchCount(qTokens: readonly string[], tokenSet: string): number {
  let n = 0;
  for (const q of qTokens) if (tokenSet.includes(q)) n++;
  return n;
}
