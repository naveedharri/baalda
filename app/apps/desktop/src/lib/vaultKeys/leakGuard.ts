// Red team 3: a vault key must never leave this computer by accident, the
// classic way being "support asked me to attach the file". Detects the saved
// key file (its header) and any 24 consecutive words that ARE a valid vault
// key (BIP39 checksum), numbered or not. Only runs of words from the BIP39
// list are tried, so large logs stay cheap and ordinary prose never matches.

import { wordlist as english } from "@scure/bip39/wordlists/english.js";
import { wordsToVaultKey } from "./crypto";

const FILE_HEADER = "baalda vault key for";
const WORDS = new Set(english);
const PHRASE = 24;

export function containsVaultKey(text: string): boolean {
  if (typeof text !== "string" || !text) return false;
  const lower = text.toLowerCase();
  if (lower.includes(FILE_HEADER)) return true;
  // Numbers and punctuation ("1. word") separate tokens; only letters count.
  const tokens = lower.match(/[a-z]+/g) ?? [];
  let run: string[] = [];
  const tryRun = () => {
    for (let i = 0; i + PHRASE <= run.length; i++) {
      const vk = wordsToVaultKey(run.slice(i, i + PHRASE).join(" "));
      if (vk) {
        vk.fill(0);
        return true;
      }
    }
    return false;
  };
  for (const t of tokens) {
    if (WORDS.has(t)) {
      run.push(t);
      continue;
    }
    if (run.length >= PHRASE && tryRun()) return true;
    run = [];
  }
  return run.length >= PHRASE && tryRun();
}

export const VAULT_KEY_LEAK_MESSAGE =
  "This looks like a vault key. Never send your vault key to anyone, including Baalda support. Remove it and try again.";
