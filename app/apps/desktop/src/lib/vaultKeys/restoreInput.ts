// "Restore with vault key": reading what a person pastes or opens (pure, for
// tests). The input may be the 24 words alone, numbered, split over lines, or
// the whole saved key file (a title, the vault id and a note above the words),
// so a line that holds a complete key on its own wins over everything else.

import { isVaultKeyWord, wordsToVaultKey } from "./crypto";
import type { RestoreResult } from "./session";

export const KEY_WORD_COUNT = 24;

export interface KeyInput {
  /** The words as read, lowercase, in order (at most what was typed). */
  words: string[];
  /** Indexes into `words` that are not key words (only finished words). */
  unknown: number[];
  /** The 24 words as one line when they form a valid key, else null. */
  phrase: string | null;
  /** 24 known words whose checksum fails: one is mistyped or out of order. */
  checksumFailed: boolean;
}

const tokens = (text: string) =>
  text
    .replace(/[^\p{L}\s]+/gu, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

export function readKeyInput(text: string): KeyInput {
  // The saved key file: the key is one line of its own.
  for (const line of text.split(/\r?\n/)) {
    const t = tokens(line);
    if (t.length === KEY_WORD_COUNT && wordsToVaultKey(t.join(" "))) {
      return { words: t, unknown: [], phrase: t.join(" "), checksumFailed: false };
    }
  }
  const words = tokens(text);
  // The last word may still be being typed: judge it once something follows.
  const finished = /[\s\p{P}]$/u.test(text) ? words.length : words.length - 1;
  const unknown: number[] = [];
  words.forEach((w, i) => {
    if (i < finished && !isVaultKeyWord(w)) unknown.push(i);
  });
  const complete = words.length === KEY_WORD_COUNT && words.every(isVaultKeyWord);
  const phrase = complete && wordsToVaultKey(words.join(" ")) ? words.join(" ") : null;
  return { words, unknown, phrase, checksumFailed: complete && !phrase };
}

/** The one line under the word grid: progress, a problem, or ready. */
export function keyInputStatus(input: KeyInput): { tone: "muted" | "error" | "ok"; text: string } {
  const n = input.words.length;
  if (input.phrase) return { tone: "ok", text: "All 24 words look right." };
  if (input.unknown.length) {
    const w = input.words[input.unknown[0]];
    return { tone: "error", text: `“${w}” is not one of the key words. Check its spelling.` };
  }
  if (n > KEY_WORD_COUNT) return { tone: "error", text: `That is ${n} words. A vault key has exactly 24.` };
  if (input.checksumFailed) {
    return { tone: "error", text: "These 24 words do not make a valid key. One may be mistyped or out of order." };
  }
  if (n === 0) return { tone: "muted", text: "Paste the words, or open the key file you saved." };
  return { tone: "muted", text: `${n} of 24 words` };
}

/** What a finished restore says, in plain words (null = success). */
export function restoreErrorMessage(result: RestoreResult | undefined): string | null {
  switch (result) {
    case "restored":
      return null;
    case "wrong-key":
      return "That key belongs to a different vault. Nothing was changed.";
    case "invalid-words":
      return "Those are not 24 valid key words. Check each word.";
    case "security-warning":
      return "Your security key does not match this computer, so keys are paused here. Nothing was changed.";
    case "disabled":
      return "This server does not support vault keys.";
    default:
      return "The key could not be checked right now. Check your connection and try again. Nothing was changed.";
  }
}
