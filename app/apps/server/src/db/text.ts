/**
 * Postgres `text` cannot hold U+0000 — every INSERT of a note body carrying one
 * fails with `invalid byte sequence for encoding "UTF8": 0x00`, which took a
 * whole vault's daily checkpoint down with it in production (one note in
 * `Archive/…` held a NUL). Yjs text is fine with it; only the DERIVED copies
 * (search index, versions, checkpoints) live in Postgres, so strip it there.
 * The CRDT — the note itself — is untouched.
 */
export function pgText(s: string): string {
  return s.includes("\u0000") ? s.replace(/\u0000/g, "") : s;
}
