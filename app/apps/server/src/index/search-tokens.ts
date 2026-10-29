import { tokenize } from "./embedder.js";

/** Upper bound on a stored token set, in UTF-16 code units (all ASCII here). */
export const SEARCH_TOKENS_MAX = 64 * 1024;

/**
 * The derived keyword set search scores against instead of reading note text in
 * SQL: unique `tokenize()` output in first-seen order, joined by single spaces,
 * capped at {@link SEARCH_TOKENS_MAX}. A query token (always `[a-z0-9_]+`) is a
 * substring of `lower(text)` exactly when it is a substring of one maximal
 * `[a-z0-9_]` run, i.e. of one token, so `set.includes(q)` reproduces the old
 * `position(q IN lower(text)) > 0` (the space separator is outside the alphabet
 * and can never be part of a match). Known gaps: a note whose unique tokens pass
 * the cap, and a non-ASCII letter whose lowercase differs between JS and
 * Postgres (e.g. U+0130 lowers to "i" + U+0307 in JS, splitting the token).
 */
export function searchTokenSet(text: string): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  let len = 0;
  for (const t of tokenize(text)) {
    if (seen.has(t)) continue;
    seen.add(t);
    const next = parts.length === 0 ? t.length : len + 1 + t.length;
    if (next > SEARCH_TOKENS_MAX) break;
    parts.push(t);
    len = next;
  }
  return parts.join(" ");
}

/** How many of the (unique) query tokens occur in a stored token set. */
export function keywordMatchCount(qTokens: readonly string[], tokenSet: string): number {
  let n = 0;
  for (const q of qTokens) if (tokenSet.includes(q)) n++;
  return n;
}
