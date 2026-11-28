/**
 * The server-acknowledged state vector (offline reconciliation, Phase 0).
 *
 * `pushed` answers "was this doc's content confirmed on the server ONCE, ever"
 * and is a badge. What an inbound delete / revocation / disk-delete gate needs is
 * different: "does this device hold ops the server has not acknowledged?" A
 * stale device (nothing new since its last ack) must accept a teammate's delete;
 * a device holding unseen work must recover it first.
 *
 * `ackedSv` is the per-doc Yjs state vector the server is known to cover: taken
 * from the doc when a Hocuspocus `synced` lands for it and when a batch push is
 * acknowledged; for a backfill/bootstrap apply, from the SERVER'S UPDATE itself
 * (`encodeStateVectorFromUpdate`), never from the local doc after it, because a
 * server diff proves nothing about local ops but everything about its own.
 * Without that, a teammate's edit received after this device's last ack read as
 * this device's own unsent work when access went (2026-11-28). It only ever grows — the
 * server never forgets ops — so recording merges per-client clocks by max.
 */
import * as Y from "yjs";

/** Per-client clock map of an encoded state vector (`{}` for garbage). */
function decode(sv: Uint8Array): Map<number, number> {
  try {
    return Y.decodeStateVector(sv);
  } catch {
    return new Map();
  }
}

/** Does `acked` cover every op in `local` (no client clock in local exceeds it)? */
export function svCovers(acked: Uint8Array, local: Uint8Array): boolean {
  const a = decode(acked);
  for (const [client, clock] of decode(local)) {
    if (clock > (a.get(client) ?? 0)) return false;
  }
  return true;
}

/** Per-client max of two state vectors, encoded. */
export function mergeSv(a: Uint8Array | null, b: Uint8Array): Uint8Array {
  if (!a) return b;
  const out = decode(a);
  for (const [client, clock] of decode(b)) {
    if (clock > (out.get(client) ?? 0)) out.set(client, clock);
  }
  return encodeSvMap(out);
}

/**
 * What a SERVER-SENT update proves the server holds: for every client in it,
 * all ops up to the end of that client's run (`parseUpdateMeta(...).to`). The
 * server's document is complete, so a delta carrying client c's ops up to clock
 * `to` means it holds c's ops 0..to. Not `Y.encodeStateVectorFromUpdate`: that
 * counts only clients whose run starts at clock 0, so a teammate typing on in
 * one session (every later delta starts above 0) recorded nothing.
 */
export function ackSvFromServerUpdate(update: Uint8Array): Uint8Array {
  const { to } = Y.parseUpdateMeta(update);
  return encodeSvMap(to);
}

/** Encode a client→clock map as a Yjs state vector (varuint count, then pairs). */
function encodeSvMap(m: Map<number, number>): Uint8Array {
  const bytes: number[] = [];
  const writeVarUint = (n: number) => {
    while (n > 0x7f) {
      bytes.push((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    bytes.push(n);
  };
  // Yjs writes clients in descending order; order is not semantic.
  const entries = [...m.entries()].sort((x, y) => y[0] - x[0]);
  writeVarUint(entries.length);
  for (const [client, clock] of entries) {
    writeVarUint(client);
    writeVarUint(clock);
  }
  return Uint8Array.from(bytes);
}

/** True iff the state vector names no ops at all. */
export function svIsEmpty(sv: Uint8Array | null): boolean {
  if (!sv) return true;
  for (const clock of decode(sv).values()) if (clock > 0) return false;
  return true;
}

export function svToBase64(sv: Uint8Array): string {
  let s = "";
  for (const b of sv) s += String.fromCharCode(b);
  return btoa(s);
}

export function svFromBase64(b64: string): Uint8Array | null {
  try {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * The unseen-work predicate, given everything a caller could gather.
 *
 *  - A local CRDT with ops, and no acked SV at all ⇒ true (never acknowledged).
 *  - A local CRDT ⇒ true iff the acked SV does not cover it.
 *  - No local CRDT (a never-opened note) ⇒ the file-level fallback: the file's
 *    hash differs from the last hash this device agreed with the server on. With
 *    no base either, a non-empty file is treated as unseen (the safe direction).
 */
export function unseenWork(input: {
  localSv: Uint8Array | null;
  ackedSv: Uint8Array | null;
  /** sha256 of the file now, or null when there is no file / it is empty. */
  fileHash?: string | null;
  /** sha256 the device last agreed with the server on, or null. */
  diskBase?: string | null;
}): boolean {
  const { localSv, ackedSv } = input;
  if (localSv && !svIsEmpty(localSv)) {
    if (!ackedSv) return true;
    return !svCovers(ackedSv, localSv);
  }
  const fileHash = input.fileHash ?? null;
  if (fileHash === null) return false;
  const base = input.diskBase ?? null;
  return base === null || base !== fileHash;
}
