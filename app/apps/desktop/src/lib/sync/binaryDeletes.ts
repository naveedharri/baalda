// Disk deletes for BINARIES — the blob mirror's half of `#93`.
//
// A note that vanishes from disk reaches the server through
// `SyncManager.drainDiskDeletes`. A binary had no such path at all: attachment
// identity is the sha256 and nothing else, so a file deleted here was simply
// content the server had and this device did not — which is precisely the
// shape of `toDownload`. Deleting a synced PDF in Finder (or from the sidebar)
// therefore DOWNLOADED IT BACK on the next pass, forever. This queue is what
// makes the delete mean what it says.
//
// It mirrors the note queue's rails one for one, because every one of them is a
// way to destroy something that must not be destroyed:
//
//   · a {@link BINARY_DELETE_GRACE_MS} window before anything is believed, and
//     the DISK — not the event — decides at the end of it. A file that is back
//     by then was never deleted: an editor that saves by unlinking and
//     rewriting, a `git checkout`, a rename-back. (The notes spell this rail as
//     "a `modified` cancels a pending delete" because Rust tells them which is
//     which; for a binary every event is a `tree` event, so the disk check IS
//     the cancel.);
//   · a RENAME is paired by content: a pending delete whose bytes turn up at an
//     unmapped path in the same window is that file moving, so the `files` row
//     (and with it the ACL every share on it) MOVES instead of dying and being
//     re-created under a new identity;
//   · the server must already hold the bytes. "Not pushed" is the note queue's
//     refusal for the same reason — the only copy may be the local one — and
//     here it is literal: no blob, nothing to delete, nothing to resurrect;
//   · a blast-radius cap, because an unmounted volume looks exactly like a bulk
//     delete and the honest response to "everything vanished at once" is to do
//     nothing at all;
//   · not live ⇒ startup, where a missing file means the disk isn't ready.
//
// The one rail deliberately NOT mirrored is the trash copy. A note's text
// survives its file (the CRDT holds it), so `drainDiskDeletes` can keep a copy
// before it tells the server. A binary's bytes exist only in the file that was
// just deleted — the sole remaining copy is the server's, and downloading it
// back in order to file it in `.context/trash/` would undo the delete we were
// asked to make. So there is none, and the refusals above are what stand in for
// it.

import { IPC_CONCURRENCY, REGISTRY_CONCURRENCY, runPool } from "./pool";

/** How long a vanished binary waits before it is believed. Same window the
 *  notes use (`docSession.DISK_DELETE_GRACE_MS`) — the events it filters are
 *  the same events. */
export const BINARY_DELETE_GRACE_MS = 2_500;

/**
 * How many windows a candidate may spend waiting for a listing it cannot get
 * before the queue gives up on it.
 *
 * A transport failure is not an answer about a file — and the dangerous half is
 * not the delete it postpones, it is the RENAME it cannot see: a candidate
 * dropped here leaves its bytes sitting at an unregistered path, which the blob
 * mirror then registers as a SECOND `files` row (one file, two doc_ids, the ACL
 * on the wrong one). So a failed listing keeps the candidate and re-arms rather
 * than falling through, and only a window that keeps failing is abandoned — the
 * same "a later pass brings the file back and deleting it again makes it stick"
 * outcome as before, just three tries later.
 */
/**
 * How many "is it still there?" disk checks run at once when a window closes.
 *
 * Local IPC calls, bounded by Rust's file work rather than by a host's
 * connection pool — so the shared local width, not the registry's HTTP one.
 */
const EXISTS_CONCURRENCY = IPC_CONCURRENCY;

export const MAX_LISTING_RETRIES = 3;

/**
 * How many binaries may disappear in one window before the whole batch is
 * abandoned. Same shape as the notes' `diskDeleteCap`: a floor of 5 so tidying
 * a handful of files still works, and a fifth of the vault past that.
 */
export function binaryDeleteCap(binaryCount: number): number {
  return Math.max(5, Math.ceil(binaryCount * 0.2));
}

/** One local binary, as `ipc.listBinaries` reports it. */
export interface LocalBinary {
  relPath: string;
  sha256: string;
}

/** One server blob, as `api.listVaultBlobs` reports it. */
export interface RemoteBlob {
  id: string;
  sha256: string;
  relPath: string | null;
}

/** Injected I/O, so the queue runs under vitest without Tauri or a server. */
export interface BinaryDeleteDeps {
  /** Is the vault this queue belongs to still the open one? */
  isCurrent(): boolean;
  /**
   * Is the session live enough to believe a missing file? The same gate the
   * note queue's `liveSince` is: at startup a file that isn't there yet means
   * the disk (or the pull) hasn't caught up, not that anyone deleted it.
   */
  isLive(): boolean;
  /** Is the file at this path on disk right now (`ipc.fileStat`)? */
  exists(relPath: string): Promise<boolean>;
  /** Every local binary — the rename hunt and the blast-radius cap read it. */
  listLocal(): Promise<LocalBinary[]>;
  /** Every blob the server holds for this vault. */
  listServer(): Promise<RemoteBlob[]>;
  /** The server `files` id this device registered for a path, if any. */
  fileId(relPath: string): string | null;
  /** Forget a registration whose file is gone. */
  forgetFileId(relPath: string): void;
  /** Move one to the path its bytes turned up at. */
  moveFileId(from: string, to: string): void;
  /** `DELETE /api/files/:id` — the row and its bytes. */
  deleteFile(id: string): Promise<void>;
  /** `DELETE /api/blobs/:id`, never forced: a 409 is an answer, not a failure. */
  deleteBlob(id: string): Promise<void>;
  /** Re-register the SAME files id at a new path; the server treats it as a
   *  move (`POST /api/files`, the by-id branch). */
  moveFile(input: { id: string; relPath: string }): Promise<void>;
  /** Tell the user about the one thing they can act on: a refused bulk batch. */
  notify?: (text: string, tone?: "error" | "neutral" | "success") => void;
  /**
   * Something actually moved on the server (a delete, a rename). Wired to the
   * mirror's debounced reconcile, which is also what re-publishes the sidebar's
   * file dots: that map is rebuilt from the two listings on every pass, so a
   * path that is gone from both loses its dot there rather than through a
   * second, partial emission from here.
   */
  onServerChanged?: () => void;
  setTimeoutImpl?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutImpl?: (t: ReturnType<typeof setTimeout>) => void;
}

interface Pending {
  relPath: string;
  seenAt: number;
  /** How many windows this candidate has spent on a listing that failed. */
  attempts: number;
}

/** The HTTP status an api/transport error carries, when it carries one. */
function errStatus(e: unknown): number | null {
  if (!e || typeof e !== "object") return null;
  const s = (e as { status?: unknown }).status;
  return typeof s === "number" ? s : null;
}

/** Paths compare case-insensitively everywhere here, exactly as they do in the
 *  registry and on the server (`lower(path)` unique indexes): a disk that says
 *  `Team/Report.pdf` and a blob that says `team/report.pdf` are one file. */
function key(relPath: string): string {
  return relPath.toLowerCase();
}

export class BinaryDeleteQueue {
  /** Every binary path this window has heard about, by lowercased path — the
   *  same case-insensitive identity the registry and the server use. The drain
   *  splits it into "gone" (a delete) and "still there" (a save, or the arrival
   *  half of a rename). */
  private readonly pending = new Map<string, Pending>();
  /**
   * Paths THIS app removed on purpose, each owed exactly one watcher echo.
   *
   * The one removal that needs this is a revocation: the inbound plan takes a
   * file off disk because the server says this user may no longer read it, and
   * to the drain below that is indistinguishable from the user deleting it —
   * gone from disk, still on the server. It would answer with
   * `DELETE /api/files/:id`, destroying the OWNER's copy of a file they had
   * merely stopped sharing. The same one-echo-per-path claim the registry makes
   * for a materialized note (`registry.markMaterialized`).
   *
   * A materialized DOWNLOAD needs no claim: that file is present when the window
   * closes, so the disk check already says "not a delete".
   */
  private readonly suppressed = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private draining = false;
  /** Candidates this drain is KEEPING for another window (see
   *  {@link MAX_LISTING_RETRIES}), so the `finally` sweep leaves them alone. */
  private readonly retained = new Set<string>();

  constructor(
    private readonly deps: BinaryDeleteDeps,
    private readonly graceMs = BINARY_DELETE_GRACE_MS,
  ) {}

  private get setTimeoutImpl() {
    return this.deps.setTimeoutImpl ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  }
  private get clearTimeoutImpl() {
    return this.deps.clearTimeoutImpl ?? ((t: ReturnType<typeof setTimeout>) => clearTimeout(t));
  }

  /**
   * The watcher reported something about a binary at this path.
   *
   * ONE entry point for every kind, deliberately. Rust classifies every
   * non-note file as `tree` whether it was written or removed
   * (`watcher.rs plan_batch`), so "was it a delete?" is not a question the
   * event can answer — only the disk can, and only once the grace window has
   * run. So each touched path is recorded and the drain asks: gone ⇒ a delete,
   * still there ⇒ it was a save (or the arrival half of a rename), and the
   * "cancel" rail the notes spell out as a line of code is here the same disk
   * check that finds it present.
   */
  noteChanged(relPath: string): void {
    if (!this.deps.isCurrent()) return;
    // Our own removal echoing back. Consumed, so the SECOND event for the path
    // (a file the user later re-creates and deletes for real) is ordinary again.
    if (this.suppressed.delete(key(relPath))) return;
    // Not live ⇒ startup: a file that isn't there yet is a disk (or a pull)
    // catching up, not a deletion. Refused HERE rather than at drain time so
    // the window never starts and the path stays downloadable meanwhile.
    if (!this.deps.isLive()) return;
    const prior = this.pending.get(key(relPath));
    this.pending.set(key(relPath), {
      relPath,
      seenAt: Date.now(),
      // A path we are already retrying keeps its count: a watcher event is not
      // evidence that the server is reachable again.
      attempts: prior?.attempts ?? 0,
    });
    this.arm();
  }

  /**
   * Is this path inside an open delete window?
   *
   * `AttachmentSync` asks before every download, and this is the reason a
   * delete sticks. A deleted file is, to that diff, content the server has and
   * we don't — so the debounced pass (400ms, well inside the 2.5s window) would
   * put it straight back before the queue had even decided. Downloads only: an
   * upload cannot resurrect a file that is no longer on disk to read.
   */
  isPending(relPath: string): boolean {
    return this.pending.has(key(relPath));
  }

  /**
   * Is a delete window still UNDECIDED — a candidate the queue could not settle
   * because the listing it needs is unreachable?
   *
   * `AttachmentSync.ensureFileRow` asks before it mints a NEW `files` row, and
   * this is the other half of the anti-fork rail. While a vanished binary is
   * waiting for a listing, the bytes it holds may be sitting at a path this
   * device has not registered yet — exactly the rename this queue is about to
   * pair. Registering that path meanwhile creates the second row the pairing
   * was there to prevent, and no later pass can merge two live ids.
   *
   * Deliberately path-agnostic: the sha that would name the file is on the
   * server listing that just failed, so the honest answer is "a rename may be in
   * flight", not "this one is". The cost of being coarse is a pass or two
   * without a doc_id for a genuinely new file, which `ensureFileRow` already
   * treats as ordinary (the bytes go either way).
   */
  hasUnsettled(): boolean {
    for (const item of this.pending.values()) if (item.attempts > 0) return true;
    return false;
  }

  /**
   * Claim the watcher echo for a path this app is ABOUT to remove itself, so the
   * removal is never propagated back to the server as a user delete.
   *
   * Called before the removal, never after: the watcher's debounce is 150 ms and
   * the claim has to be in place first. Bounded for the same reason
   * `registry.markMaterialized` is — an echo that never arrives (the vault was
   * closed, the write fell outside the watcher's window) would otherwise pin the
   * entry forever.
   */
  suppressNext(relPath: string): void {
    if (this.suppressed.size > 20_000) this.suppressed.clear();
    this.suppressed.add(key(relPath));
    // A window already open for this path is ours too: the revocation is the
    // reason the file is gone, so there is nothing left to decide.
    this.pending.delete(key(relPath));
  }

  private arm(): void {
    if (this.timer) this.clearTimeoutImpl(this.timer);
    this.timer = this.setTimeoutImpl(() => {
      this.timer = null;
      void this.drain().catch((e) => console.warn("[attachments] delete drain failed", e));
    }, this.graceMs);
  }

  /**
   * Propagate the deletes that survived their window.
   *
   * Public because the timer is not the only caller that matters: the tests
   * drive it directly, and nothing about it assumes the timer fired.
   */
  async drain(): Promise<void> {
    if (this.draining) return;
    if (!this.deps.isCurrent()) return;
    const batch = [...this.pending.values()];
    if (batch.length === 0) return;
    this.draining = true;
    try {
      if (!this.deps.isLive()) {
        console.info(
          `[attachments] ${batch.length} binaries vanished before this session was live — left on the server`,
        );
        return;
      }

      // 1. Ask the DISK, which is the only thing that knows. Gone ⇒ a delete;
      //    still there ⇒ it was a save, a rewrite, a checkout — or the arrival
      //    half of a rename, which step 2 pairs by content.
      //    Pooled: these are N independent disk questions, and a window that
      //    caught a deleted folder asks hundreds of them. The ANSWERS are
      //    collected by index and read back in order below, so which lane
      //    finished first can never reorder `gone` (the rename pairing in step 2
      //    walks it).
      const missing = new Array<boolean>(batch.length).fill(false);
      let switched = false;
      await runPool(
        batch,
        async (item, i) => {
          try {
            missing[i] = !(await this.deps.exists(item.relPath));
          } catch {
            missing[i] = false; // couldn't ask ⇒ never assume a delete
          }
          if (!this.deps.isCurrent()) switched = true;
        },
        { concurrency: EXISTS_CONCURRENCY, shouldStop: () => switched },
      );
      if (switched || !this.deps.isCurrent()) return;
      const gone: Pending[] = [];
      const present: string[] = [];
      batch.forEach((item, i) => (missing[i] ? gone.push(item) : present.push(item.relPath)));
      if (gone.length === 0) return;

      let local: LocalBinary[];
      let server: RemoteBlob[];
      try {
        [local, server] = await Promise.all([this.deps.listLocal(), this.deps.listServer()]);
      } catch (e) {
        // Offline, a restarting server, or an epoch-pinned read refused across a
        // vault switch. Nothing is decided here — and dropping the candidates
        // would decide the WORST of it: a rename this window was about to pair
        // by content becomes an unregistered path, and the blob mirror gives it
        // a second `files` row. So they wait for another window, and only a
        // candidate that keeps failing falls through to the old outcome (the
        // server still holds the bytes, so a later pass brings the file back and
        // deleting it again, online this time, is what makes it stick).
        // The WHOLE batch, not just the vanished half: the arrival half of a
        // rename is what pairs it, and a partner swept from `pending` here
        // would leave the next window looking at an unexplained delete.
        const kept: string[] = [];
        for (const item of batch) {
          if (item.attempts + 1 >= MAX_LISTING_RETRIES) continue;
          item.attempts += 1;
          this.retained.add(key(item.relPath));
          kept.push(item.relPath);
        }
        console.warn(
          `[attachments] delete drain: listing failed — leaving the server alone` +
            (kept.length > 0 ? `; retrying ${kept.length} in another window` : ""),
          e,
        );
        if (kept.length > 0) this.arm();
        return;
      }
      if (!this.deps.isCurrent()) return;

      const blobByPath = new Map<string, RemoteBlob>();
      for (const b of server) if (b.relPath) blobByPath.set(key(b.relPath), b);
      const localBySha = new Map<string, LocalBinary[]>();
      for (const a of local) {
        const list = localBySha.get(a.sha256);
        if (list) list.push(a);
        else localBySha.set(a.sha256, [a]);
      }
      const unpaired = new Set(present.map(key));

      // 2. Renames, by content. A pending delete whose bytes are sitting at a
      //    path that appeared in the same window is that file moving.
      const deletes: Array<{ relPath: string; blob: RemoteBlob }> = [];
      for (const item of gone) {
        const blob = blobByPath.get(key(item.relPath));
        if (!blob) {
          // The server never held these bytes: nothing to delete, and nothing
          // that could ever come back down. The note queue's `isPushed` refusal,
          // stated in the only terms a binary has.
          console.info(
            `[attachments] ${item.relPath} was deleted on disk but the server holds no copy — nothing to propagate`,
          );
          this.deps.forgetFileId(item.relPath);
          continue;
        }
        const renamedTo = this.matchRename(blob.sha256, localBySha, unpaired);
        if (renamedTo) {
          unpaired.delete(key(renamedTo));
          const moved = await this.applyRename(item.relPath, renamedTo);
          if (!this.deps.isCurrent()) return;
          // A move the server refused is the fork case again: the new path is
          // unregistered and the mirror would give it its own row. Keep the
          // candidate so the next window tries the move again.
          if (!moved && item.attempts + 1 < MAX_LISTING_RETRIES) {
            item.attempts += 1;
            this.retained.add(key(item.relPath));
            // …with the path its bytes are at now, or the next window has a
            // delete with nothing to pair it to.
            if (this.pending.has(key(renamedTo))) this.retained.add(key(renamedTo));
          }
          continue;
        }
        deletes.push({ relPath: item.relPath, blob });
      }
      if (deletes.length === 0) return;

      // 3. Blast radius, against the vault as it stands: the survivors are gone
      //    from `local` already, so they are added back to the count.
      const cap = binaryDeleteCap(local.length + deletes.length);
      if (deletes.length > cap) {
        console.warn(
          `[attachments] ${deletes.length} files disappeared from disk at once (cap ${cap}) — not removed from the server`,
          deletes.slice(0, 10).map((d) => d.relPath),
        );
        this.deps.notify?.(
          `${deletes.length} files disappeared from disk at once — they were NOT removed from the server. ` +
            `If the folder was unmounted or checked out, reopening the vault restores them.`,
          "error",
        );
        return;
      }

      // 4. Tell the server. A tree file goes through its `files` row, which
      //    takes the blob with it; an `attachments/` drop (and a tree file this
      //    device never registered) has only its blob to remove.
      //    Pooled at the registry width — every decision that could refuse a
      //    removal (the grace window, the rename pairing, the cap in step 3) has
      //    already run, so all that is left is N independent requests.
      let changed = false;
      await runPool(
        deletes,
        async (d) => {
          const id = this.deps.fileId(d.relPath);
          try {
            if (id) await this.deps.deleteFile(id);
            else await this.deps.deleteBlob(d.blob.id);
          } catch (e) {
            if (errStatus(e) === 409) {
              // `blob_referenced`: a note still embeds these bytes. The file is
              // gone from THIS disk, but the server's copy is somebody's image —
              // leave it, and let it come back down here on the next pass.
              console.info(
                `[attachments] ${d.relPath} is still embedded in a note — keeping the server copy`,
              );
              return;
            }
            console.warn(`[attachments] couldn't remove ${d.relPath} from the server`, e);
            return;
          }
          this.deps.forgetFileId(d.relPath);
          changed = true;
          console.info(
            `[attachments] ${d.relPath} was deleted on this device — removed from the server`,
          );
        },
        { concurrency: REGISTRY_CONCURRENCY, shouldStop: () => !this.deps.isCurrent() },
      );
      if (changed) this.deps.onServerChanged?.();
    } finally {
      this.draining = false;
      // Whatever happened, this window is spent: everything in the batch has
      // been decided, refused or reported. A path that vanished AGAIN while we
      // were working has its own entry and its own window.
      for (const item of batch) {
        if (this.retained.delete(key(item.relPath))) continue;
        if (this.pending.get(key(item.relPath)) === item) this.pending.delete(key(item.relPath));
      }
    }
  }

  /** Which candidate path (if any) now holds exactly these bytes? */
  private matchRename(
    sha256: string,
    localBySha: Map<string, LocalBinary[]>,
    candidates: Set<string>,
  ): string | null {
    if (candidates.size === 0 || !sha256) return null;
    for (const a of localBySha.get(sha256) ?? []) {
      if (candidates.has(key(a.relPath))) return a.relPath;
    }
    return null;
  }

  /**
   * A rename done outside the app: move the `files` row instead of deleting it.
   *
   * `POST /api/files` with the SAME id and the new path is the server's move
   * (its by-id branch updates `path`/`folder_id`), so the doc_id — and every
   * share hanging off it — survives being renamed in Finder. A path this device
   * never registered has no row to move: its identity is the hash, which did not
   * change, so the rename is already a no-op everywhere.
   */
  private async applyRename(from: string, to: string): Promise<boolean> {
    const id = this.deps.fileId(from);
    if (!id) {
      console.info(`[attachments] ${from} → ${to} (renamed on disk; no files row to move)`);
      return true;
    }
    try {
      await this.deps.moveFile({ id, relPath: to });
    } catch (e) {
      // The row stayed where it was. Nothing was deleted, which is the safe
      // half — but the new path is now an unregistered one, and the mirror
      // registering it would fork the file across two doc_ids. Answering
      // `false` is what keeps the candidate for another window instead.
      console.warn(`[attachments] couldn't move the files row ${from} → ${to}`, e);
      return false;
    }
    if (!this.deps.isCurrent()) return true;
    this.deps.moveFileId(from, to);
    this.deps.onServerChanged?.();
    console.info(`[attachments] ${from} → ${to} (renamed on disk; keeping file ${id})`);
    return true;
  }

  /** Drop the armed window. MUST be called when the vault stops being current —
   *  a live timer keeps this queue (and its captured vault) alive. */
  stop(): void {
    if (this.timer) {
      this.clearTimeoutImpl(this.timer);
      this.timer = null;
    }
    this.pending.clear();
    this.suppressed.clear();
    this.retained.clear();
  }
}
