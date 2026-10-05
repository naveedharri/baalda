/**
 * Offline-reconciliation report: an in-memory, per-app-session list of the
 * things sync did on the user's behalf that they should hear about (a file
 * restored from the server, a teammate's delete that sent their unsent edits
 * to `.context/trash`, a same-path create renamed aside, ...).
 *
 * The sync layer RECORDS; the UI subscribes / drains. Nothing here persists.
 */
export type ReconcileKind =
  | "restoredFromServer" // D5/D8: a file missing locally was re-materialised from the server (B's closed-app delete undone)
  | "deletedByTeammate" // D1: a teammate deleted a note B had unseen edits to; B's version went to trash (local and/or server)
  | "renamedConflict" // D4: same-path create; B's later note renamed to newPath
  | "keptLocally" // D7: access revoked while B had unsent edits; kept under .context/trash, no longer synced
  | "selfRevoked" // D7, but B removed their OWN access from this device moments before; same copy, quiet notice
  | "folderKept" // D8: teammate deleted a folder but B's new notes inside it kept it alive
  | "externalEditSaved" // another app edited a never-opened note offline; the server's text won, the file went to trash (detail = trash path)
  | "conflictKeptServer"; // one-step create met DIFFERENT server text (adopt/conflict merge): server text kept, local text to trash (detail = trash path)

export interface ReconcileItem {
  kind: ReconcileKind;
  docId?: string;
  path: string;
  newPath?: string;
  detail?: string;
  at: number;
  /**
   * Re-recorded from the last session's saved review on vault open, not
   * something sync just did. The review and Activity list it; the banner never
   * announces it again (it already did, the session it happened in).
   */
  seeded?: boolean;
}

export interface ReconcileListener {
  (items: ReconcileItem[]): void;
}

import { vaultScopes } from "./vaultScope";

/**
 * Every entry belongs to the vault that was open when it was recorded, and
 * every reader sees only the OPEN vault's entries. Before this the list was
 * one flat array for the whole app session, so switching vaults carried vault
 * A's "kept on this device" / "restored" rows into vault B's banner, review
 * count and Activity panel (#304's visible half). Entries for other vaults are
 * kept, not dropped: switching back shows them again.
 *
 * The key is the scope's folder path (`vaultScopes.current()?.vaultPath`),
 * the same key `useReviewPersistence` saves under. An entry recorded while no
 * vault scope is current (a pass that outlived its vault, or a unit test) is
 * keyed `null` and is visible only while no vault is open — which in the app
 * means never, since the Activity panel needs a vault.
 */
const all: ReconcileItem[] = [];
const vaultOf = new WeakMap<ReconcileItem, string | null>();
const drained = new WeakSet<ReconcileItem>();
const listeners = new Set<ReconcileListener>();

function currentVault(): string | null {
  return vaultScopes.current()?.vaultPath ?? null;
}

function visible(): ReconcileItem[] {
  const key = currentVault();
  return all.filter((it) => (vaultOf.get(it) ?? null) === key);
}

function notify(): void {
  const snapshot = visible();
  for (const cb of listeners) {
    try {
      cb(snapshot);
    } catch (e) {
      console.warn("[reconcileReport] listener threw", e);
    }
  }
}

function sameSeed(a: ReconcileItem, b: Omit<ReconcileItem, "seeded">, vault: string | null): boolean {
  return (
    (vaultOf.get(a) ?? null) === vault &&
    a.kind === b.kind &&
    a.path === b.path &&
    (a.docId ?? null) === (b.docId ?? null) &&
    (a.newPath ?? null) === (b.newPath ?? null) &&
    (a.detail ?? null) === (b.detail ?? null) &&
    a.at === b.at
  );
}

export const reconcileReport: {
  record(item: Omit<ReconcileItem, "at" | "seeded">, opts?: { at?: number; seeded?: boolean }): void;
  items(): ReconcileItem[];
  drain(): ReconcileItem[];
  subscribe(cb: ReconcileListener): () => void;
  clear(): void;
  forgetReadable(docIds: ReadonlySet<string>): number;
  /** The open vault changed: subscribers re-read, now filtered to the new one. */
  vaultChanged(): void;
} = {
  record(item, opts) {
    // A seeded item keeps the time it HAPPENED: stamping it with now made the
    // same rename look new (unread, bannered) on every launch.
    const at = opts?.at && Number.isFinite(opts.at) && opts.at > 0 ? opts.at : Date.now();
    const vault = currentVault();
    const entry: ReconcileItem = { ...item, at, ...(opts?.seeded ? { seeded: true } : {}) };
    // A vault reopened in the same session re-seeds its saved review while the
    // entries from its earlier open are still here; one line per fact.
    if (opts?.seeded && all.some((it) => it.seeded && sameSeed(it, entry, vault))) return;
    all.push(entry);
    vaultOf.set(entry, vault);
    notify();
  },
  items() {
    return visible();
  },
  drain() {
    const out = visible().filter((it) => !drained.has(it));
    for (const it of out) drained.add(it);
    return out;
  },
  subscribe(cb) {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
  clear() {
    const key = currentVault();
    for (let i = all.length - 1; i >= 0; i--) {
      if ((vaultOf.get(all[i]) ?? null) === key) all.splice(i, 1);
    }
    notify();
  },
  /**
   * Access came back: drop this session's "you lost this note" entries for
   * docs the server lists as readable again, so the banner shrinks instead of
   * claiming a loss that no longer holds. The recovery copy itself stays in
   * `.context/trash`; only the report line goes. A read-only refusal (the note
   * was readable all along) and items seeded from an earlier session are kept.
   * Scoped to the open vault like every other reader: a doc id is only
   * meaningful within its own vault.
   */
  forgetReadable(docIds) {
    if (docIds.size === 0 || all.length === 0) return 0;
    const key = currentVault();
    let removed = 0;
    for (let i = all.length - 1; i >= 0; i--) {
      const it = all[i];
      if ((vaultOf.get(it) ?? null) !== key) continue;
      if (!isForgettable(it, docIds)) continue;
      all.splice(i, 1);
      removed++;
    }
    if (removed === 0) return 0;
    notify();
    return removed;
  },
  vaultChanged() {
    notify();
  },
};

/**
 * Who a recovery copy belongs to. The bridge's `saveRecoveryCopy` (adapter.ts)
 * records every copy it writes, as `externalEditSaved` by default; a caller
 * that KNOWS why the server's text is about to win over a file (the one-step
 * create merge in `docSession.httpMergeOnce` / `noteSeeded`) claims the path
 * for the duration of that write so the one entry carries the right kind and
 * doc id instead of a second, contradictory one. Keyed case-insensitively,
 * like every vault path. The returned function releases only its own claim.
 */
export interface RecoveryAttribution {
  kind: ReconcileKind;
  docId?: string;
}

const attributions = new Map<string, { attr: RecoveryAttribution; token: object }>();

function attributionKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

export function attributeRecoveryCopies(path: string, attr: RecoveryAttribution): () => void {
  const key = attributionKey(path);
  const token = {};
  attributions.set(key, { attr, token });
  return () => {
    if (attributions.get(key)?.token === token) attributions.delete(key);
  };
}

export function recoveryAttribution(path: string): RecoveryAttribution | null {
  return attributions.get(attributionKey(path))?.attr ?? null;
}

/** Mirrors `READ_ONLY_DETAIL` (readOnlyRejections.ts), inlined to avoid an import cycle. */
const READ_ONLY_PREFIX = "read-only";

function isForgettable(it: ReconcileItem, docIds: ReadonlySet<string>): boolean {
  if (it.seeded || !it.docId || !docIds.has(it.docId)) return false;
  if (it.kind === "deletedByTeammate" || it.kind === "selfRevoked") return true;
  return it.kind === "keptLocally" && !(it.detail ?? "").startsWith(READ_ONLY_PREFIX);
}
