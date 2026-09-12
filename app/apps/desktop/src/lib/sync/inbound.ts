/**
 * Inbound structural reconciliation: what to change ON DISK because the server's
 * folder/note structure moved.
 *
 * The registry has always pushed local structure UP. It had no downstream half at
 * all, and the three consequences were all visible to users:
 *   - a note a teammate deleted stayed on disk forever and got re-registered,
 *     leaving a permanent sidebar entry that could never sync;
 *   - a note a teammate renamed became TWO files — the old path keeping the
 *     content, the new path materialized empty;
 *   - a folder created remotely with nothing in it never appeared at all, because
 *     the only thing that ever created a local folder was the user's own
 *     right-click. That made every MCP-created folder invisible on every device.
 *
 * This module is the decision layer, deliberately pure: no IPC, no API, no
 * filesystem. It takes four maps and returns a plan. That means every rule below
 * is testable as a table, which matters more here than anywhere else in the
 * codebase — this is the code that decides to delete someone's notes.
 */

/** docId → vault-relative path, on one side of the comparison. */
export type PathsByDocId = Map<string, string>;

export interface InboundInput {
  /** What the server says NOW (`GET /api/notes`). */
  server: PathsByDocId;
  /**
   * docIds the server says are DELETED.
   *
   * `null` means the server did not answer the question (an older server, a
   * proxy that dropped the field). It is NOT `[]`, and the difference is
   * load-bearing: with `null` we refuse to remove anything, because the only safe
   * reading of "I don't know" is "leave the user's files alone".
   */
  tombstones: Set<string> | null;
  /** Where the last AGREED reconciliation put each doc (persisted baseline). */
  baseline: PathsByDocId;
  /** What is on disk right now (the local index's docId per note path). */
  local: PathsByDocId;
  /** Folder paths the server shows us. */
  serverFolders: Set<string>;
  /** Folder paths that exist on disk. */
  localFolders: Set<string>;
  /**
   * Folder ids the server says are DELETED (`folder_tombstones`). Same contract
   * as note `tombstones`: `null` means the server did not answer (an older
   * server), and "I don't know" must never remove or suppress anything.
   */
  folderTombstones?: Set<string> | null;
  /**
   * The server folder id this device last recorded per local folder path
   * (the persisted `folders` map in `.context/config.json`). An id match against
   * a tombstone is proof the local folder IS the deleted one — a folder the
   * user re-created at the same path gets a fresh id and never matches.
   */
  localFolderIds?: Map<string, string>;
  /**
   * Server folder id → its CURRENT path. Lets the plan see a folder the server
   * MOVED: the id we recorded at a local path now lives elsewhere. The old
   * directory (emptied by the per-note renames) is then removed if empty, like a
   * tombstoned one — otherwise it lingered as a trap: a file dropped into it
   * later re-registered it as a brand-new server folder, and the folder move
   * "came back" for the whole team as an empty twin.
   */
  serverFolderIds?: Map<string, string>;
  /**
   * True when this pass's listings are a TRUSTWORTHY statement of what the
   * caller may read — not merely the absence of an answer.
   *
   * Three things have to hold, and the caller
   * (`SyncManager.revocationAuthority`, read through `InboundHost`) checks all
   * three:
   *
   *  1. The whole listing round trip succeeded — `GET /api/notes` and
   *     `GET /api/folders` both returned 200. Neither is paginated, so a 200 is
   *     the complete permission-filtered set, and a transport failure throws
   *     long before this function is reached.
   *  2. The session is LIVE: the vault channel has reached `synced` and a
   *     structure pull has already completed. That is the same bar
   *     `SyncManager.drainDiskDeletes` uses before it believes a missing file,
   *     and for the same reason — at startup, "not there yet" and "gone" look
   *     identical.
   *  3. The server ANNOUNCED an access change in the last minute (`acl-changed`
   *     → the `reauth` frame that asked for this pull). Liveness alone is not
   *     enough: a regression in the server's readable-set filter would make
   *     every routine pull — one per reconnect — look like a total revocation,
   *     and one bad deploy would then take every member's local copies. A
   *     shrunken listing nobody announced is treated as a fault, not a decision.
   *
   * The window rather than "the very next pull" is deliberate: pulls are
   * debounced and coalesced, so the pass that reads the new listing may be
   * several triggers downstream of the frame that announced the change.
   *
   * What it buys: the revocation caps below are lifted. They exist to stop a
   * hiccup from looking like a mass revoke, and a whole-vault revocation is
   * exactly the shape they cannot tell from one — Vault Settings → Access →
   * Private takes EVERY doc away at once, which is 100% of the mapped set and so
   * can never fit under a 50% ceiling. Refusing it left the vault's notes in the
   * ex-reader's sidebar and on their disk while the same action on a single
   * folder worked, because a folder is a small enough slice to fit.
   *
   * Nothing else is relaxed. Deletions and renames keep their caps (a wrong
   * delete destroys work; a wrong revoke does not — the server holds every byte
   * of a revoked doc by definition, and the executor still refuses any doc whose
   * content this device never confirmed upstream).
   */
  authoritative?: boolean;
  /**
   * WHICH docs the server named as no longer readable — the union of the vault
   * channel's `ready.revoked` and its live `drop` frames.
   *
   * `authoritative` says an access change was announced; this says what the
   * announcement was ABOUT, and the cap is lifted only for the docs it names.
   *
   * What this is NOT: an independent second opinion. Both the names and the
   * absences below come from the SAME server function
   * (`permissions/vault-docs.ts listReadableDocsInVault` — the channel and
   * `GET /api/notes` both call it), so a bug inside that one function produces
   * the short listing and the announcement together. What agreement between
   * them does buy is narrower and still worth having: the two readings are taken
   * at different moments over different transports, so a transient or racy short
   * answer on one of them alone removes nothing.
   *
   * The real cross-check is {@link InboundPlan.needsAccessCheck}, which the
   * executor resolves against `permissions/resolver.ts effectivePermission` — a
   * different query — before it deletes anything past the cap.
   *
   * Absent ⇒ `authoritative` alone lifts the cap for every revoked doc. That is
   * the old-server path: a server that names nothing here also never sends
   * `ready.revoked`, so its only authority is the live `reauth`.
   *
   * Only meaningful when `authoritative` is true; ignored otherwise.
   */
  authoritativeRevoked?: ReadonlySet<string>;
  /**
   * doc_ids the LOCAL user created (from the listing's `created_by`).
   *
   * Authorship does not survive an item set to Private — that is deliberate
   * (spec 04: a restriction its author is exempt from is not a restriction), so
   * these docs genuinely can be revoked. What it does change is HOW the file
   * leaves: the author gets the recoverable `.context/trash` copy a deleted note
   * gets, instead of an outright `deletePath`. Losing read access to a note is
   * not a reason to destroy the only local copy of something this person wrote.
   */
  authoredByMe?: ReadonlySet<string>;
}

export interface InboundRename {
  docId: string;
  from: string;
  to: string;
}

export interface InboundTrash {
  docId: string;
  path: string;
  /**
   * Why the file is leaving.
   *
   * `deleted` — the server tombstoned it: someone deleted the note.
   * `revoked` — it left the caller's readable set: access was taken away.
   *
   * Both release the doc and take the file off disk, but differently: a deleted
   * note goes to the vault's recoverable trash (the undo for a deliberate
   * removal), a revoked one is removed outright (the server still holds it, and
   * a trash copy would keep the readable `.md` the revocation takes away). They
   * also carry different risk, so they get separate safety caps and separate
   * wording when one is refused. A wrong `deleted` is a server bug destroying
   * work; a mass `revoked` is a routine admin action that happens to look the
   * same from here.
   */
  reason: "deleted" | "revoked";
  /**
   * Does the file get a copy in `.context/trash` before it goes?
   *
   * Always for `deleted` — the trash IS the undo. For `revoked` only when the
   * LOCAL user authored the note: leaving an ex-reader a readable `.md` would
   * defeat the revocation, but a person losing access to something they wrote
   * themselves must not have their only local copy destroyed by a permission
   * change. See {@link InboundInput.authoredByMe}.
   */
  recoverable: boolean;
}

export interface InboundRejection {
  kind: "rename" | "trash" | "folder";
  path: string;
  docId: string | null;
  reason: string;
}

export interface InboundPlan {
  /** Folder paths to create locally, parents before children. */
  createFolders: string[];
  /**
   * Local folder paths that must leave this disk, children before parents: the
   * server DELETED them (tombstoned by id), MOVED them elsewhere (the emptied
   * old directory), or took this user's access away (the id vanished from the
   * permission-filtered listing without a tombstone — a folder made private).
   * The executor removes each one only if it is empty by then —
   * the notes inside leave via their own tombstones in {@link trash} first, and
   * a folder still holding anything (an unconfirmed orphan, a stray image, a
   * new local note) stays on disk and re-registers under a fresh id, which is
   * the safe direction: content must live somewhere.
   */
  removeFolders: string[];
  renames: InboundRename[];
  trash: InboundTrash[];
  /**
   * Local note paths the OUTBOUND half must not re-register.
   *
   * This one field is the whole ghost fix. A tombstoned or revoked note is still
   * on disk, so it reads as "missing from the server" and gets `createNote`d —
   * which the server answers 201 to (the row exists) without clearing
   * `deleted_at`. The note then sits in the sidebar forever, unsyncable. Skipping
   * it here lets the existing prune drop the mapping instead.
   */
  suppress: Set<string>;
  /**
   * Paths of DELETED (tombstoned — the server answered) notes whose file is
   * still on disk but which the local index keys under some other id, so the
   * plan could only suppress them (see the `dead && loc === undefined` branch).
   * The executor may trash such a file if — and only if — it is empty: no work
   * to lose, and otherwise a zero-byte stub nobody can sync or count, forever.
   * Never populated for revoked notes or when tombstones were not reported.
   */
  stubs: string[];
  /**
   * doc_ids among {@link trash} whose `revoked` removal survives ONLY because an
   * authoritative pass lifted the safety cap.
   *
   * The executor must not act on these from this plan alone. It asks the server
   * a second, differently-computed question first
   * (`POST /api/vaults/:id/access-check` → `effectivePermission` per doc) and
   * removes only the ids that also come back with no access; anything the
   * resolver still grants is left on disk and reported, and a request that fails
   * removes nothing at all.
   *
   * Empty when the revoked group fitted under its cap on its own — an ordinary
   * revocation of a few notes needs no corroboration, because the cap is already
   * the thing bounding the damage.
   */
  needsAccessCheck: string[];
  rejected: InboundRejection[];
}

// ── path safety ─────────────────────────────────────────────────────────────
//
// Server-supplied paths were previously only ever CREATED (`writeNoteIfMissing`),
// which is harmless. Inbound rename makes them a destination we move existing
// files to, and `rel_path` is not validated anywhere on the way in — MCP's
// `create_note` inserts whatever string it's given. Rust won't save us either:
// `resolve_in_vault` blocks `..` and absolute paths but deliberately PERMITS
// `.context/`, since that's how the vault's own config is read. So a row saying
// `rel_path = ".context/config.json"` would be "move this note over the vault's
// doc map". Hence an explicit allowlist on this side.

/** Mirrors `IGNORED_DIRS` in src-tauri/src/vault.rs. */
/**
 * Two vault paths that name the same file.
 *
 * Case-insensitively, because that is what the filesystems we ship on do:
 * macOS/APFS and Windows store ONE entry per case-insensitive name, so
 * `Projects/community/a.md` and `Projects/Community/a.md` are the same file, not
 * two. The server agrees since migration 023 (case-insensitive unique paths), so
 * treating them as distinct here only ever produced work that could not land.
 */
export function samePath(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

const IGNORED_DIRS = [".context", ".git"];
/** Mirrors `DENIED_DIRS` in src-tauri/src/vault.rs. */
const DENIED_DIRS = [
  "node_modules",
  "dist",
  "build",
  "target",
  "vendor",
  "__pycache__",
  "venv",
];
/** Note extensions the registry reconciles (mirrors `NOTE_EXTS` in registry.ts). */
const NOTE_EXTS = ["md", "markdown", "mdx", "txt", "html", "htm", "canvas"];

const MAX_SEGMENT_BYTES = 255;
const MAX_PATH_BYTES = 1024;

function segmentsOk(path: string): boolean {
  if (!path || path.length > MAX_PATH_BYTES) return false;
  if (path.startsWith("/") || path.includes("\\")) return false;
  // Control characters would produce unopenable files and, on some platforms,
  // paths that don't round-trip.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  const segs = path.split("/");
  for (const seg of segs) {
    if (!seg || seg === "." || seg === "..") return false;
    // Any dot-prefixed segment: covers `.context`, `.git`, and every hidden dir
    // the Rust walker skips, so we can never move a note somewhere the tree
    // walk and watcher would then ignore it.
    if (seg.startsWith(".")) return false;
    if (IGNORED_DIRS.includes(seg) || DENIED_DIRS.includes(seg)) return false;
    if (seg.length > MAX_SEGMENT_BYTES) return false;
  }
  return true;
}

/** Is this a path we're willing to move a note TO (or trash FROM)? */
export function isSafeNotePath(path: string): boolean {
  if (!segmentsOk(path)) return false;
  const i = path.lastIndexOf(".");
  if (i <= 0) return false;
  return NOTE_EXTS.includes(path.slice(i + 1).toLowerCase());
}

/** Is this a path we're willing to create a folder at? */
export function isSafeFolderPath(path: string): boolean {
  return segmentsOk(path);
}

// ── circuit breakers ────────────────────────────────────────────────────────

/**
 * Ceilings on how much one pass may change, per category.
 *
 * A teammate tidying up deletes a few notes; a bug in this file, a permission
 * glitch, or a truncated response "deletes" most of the vault. There is no rule
 * that tells those apart from the inside, so we cap the blast radius instead:
 * over the line, the whole category is abandoned and reported as a failure, and
 * the next pull gets to decide again with fresh data.
 *
 * This is the guard that would have caught the incident that destroyed 428 notes.
 */
function trashCap(mapped: number): number {
  return Math.max(5, Math.ceil(mapped * 0.2));
}
/**
 * Revocation gets a more generous budget than deletion.
 *
 * Losing a whole shared folder at once is an ordinary thing for an admin to do,
 * so the deletion cap (20%) would refuse the common case. The looser limit is
 * affordable because the server still holds every one of these docs by
 * definition, so nothing is destroyed that cannot be handed back by restoring
 * access. The local file itself IS destroyed — a revoked note is removed
 * outright, with no `.context/trash` copy, because a copy there would leave the
 * ex-reader exactly the readable `.md` the revocation exists to take away (the
 * one exception is a note the local user authored; see `InboundTrash.recoverable`).
 * It is still a limit, because a truncated `GET /api/notes` looks exactly like
 * a mass revoke from here — and when it trips we keep the files, which is the
 * safe direction.
 */
function revokeCap(mapped: number): number {
  return Math.max(20, Math.ceil(mapped * 0.5));
}
function renameCap(mapped: number): number {
  return Math.max(20, Math.ceil(mapped * 0.3));
}

/** Parents before children, so a folder's parent always exists first. */
function byDepth(a: string, b: string): number {
  return a.split("/").length - b.split("/").length;
}

export function planInbound(input: InboundInput): InboundPlan {
  const plan: InboundPlan = {
    createFolders: [],
    removeFolders: [],
    renames: [],
    trash: [],
    suppress: new Set(),
    stubs: [],
    needsAccessCheck: [],
    rejected: [],
  };

  // ---- folders ------------------------------------------------------------
  //
  // Creation is unconditional; DELETION requires a tombstone. "Absent from the
  // listing" alone is undecidable — `GET /api/folders` is permission-filtered,
  // so absence means deleted OR not-visible-to-me. `folder_tombstones` (keyed by
  // folder id, exactly like note tombstones) is what makes the delete provable;
  // without it, a device still holding the folder locally re-registered it on
  // its next pull and the deleted folder came back for the whole team.
  //
  // Every comparison here is case-insensitive, exactly like the notes below
  // (`samePath`), because the filesystem is: on macOS and Windows
  // `Projects/community` and `Projects/Community` are ONE directory. Comparing
  // spellings instead of directories made a vault whose disk and server
  // disagreed on one letter (a rename-by-case on one device, or migration 023
  // merging case-duplicated rows) loop forever: `Content/pipeline` — an EMPTY
  // server folder under the mis-cased parent — read as "missing locally", so
  // pull N `ensureFolder`ed it (create_dir_all lands inside the existing
  // directory regardless of case); the watcher's `tree` event requested pull
  // N+1, which now saw the local spelling of that same id "moved" to the
  // server's spelling and removed the empty directory again; the watcher
  // requested pull N+2… One idle client pulled the whole registry (450 KB)
  // every 1.5 s for days, with the sync badge blinking Syncing/Synced (#98).
  const localFoldersCi = new Set([...input.localFolders].map((p) => p.toLowerCase()));
  const serverFoldersCi = new Set([...input.serverFolders].map((p) => p.toLowerCase()));
  for (const path of input.serverFolders) {
    if (localFoldersCi.has(path.toLowerCase())) continue;
    if (!isSafeFolderPath(path)) {
      plan.rejected.push({
        kind: "folder",
        path,
        docId: null,
        reason: "unsafe folder path from server",
      });
      continue;
    }
    plan.createFolders.push(path);
  }
  plan.createFolders.sort(byDepth);

  // A local folder whose recorded server id now lives at ANOTHER path was moved
  // remotely. Its notes move via their own renames; the emptied old directory
  // is removed (empty-only, like a tombstone) so it can't be re-registered as
  // a new folder on the next pass. Gated on the id still existing on the server
  // (a deleted id is the tombstone case below) and on the old path not having
  // been re-created server-side since.
  if (input.serverFolderIds && input.localFolderIds) {
    for (const [path, id] of input.localFolderIds) {
      const now = input.serverFolderIds.get(id);
      // A spelling disagreement is not a move: same directory on disk.
      if (now === undefined || samePath(now, path)) continue;
      if (!localFoldersCi.has(path.toLowerCase())) continue; // already gone locally
      if (serverFoldersCi.has(path.toLowerCase())) continue; // re-created server-side
      if (!isSafeFolderPath(path)) continue;
      plan.removeFolders.push(path);
    }
  }

  // A local folder whose recorded server id is tombstoned was deleted remotely.
  // Gated on the id match (a same-path successor has a fresh id and never
  // matches) and on the path not having been re-created on the server since.
  if (input.folderTombstones && input.localFolderIds) {
    for (const [path, id] of input.localFolderIds) {
      if (!input.folderTombstones.has(id)) continue;
      if (!localFoldersCi.has(path.toLowerCase())) continue; // already gone locally
      if (serverFoldersCi.has(path.toLowerCase())) continue; // re-created server-side
      if (!isSafeFolderPath(path)) {
        plan.rejected.push({
          kind: "folder",
          path,
          docId: null,
          reason: "unsafe local folder path",
        });
        continue;
      }
      plan.removeFolders.push(path);
    }
  }
  // A local folder whose recorded server id is neither listed nor tombstoned
  // has left this user's VISIBLE set: the folder (or the share that made it
  // reachable) was made private. `GET /api/folders` is permission-filtered, so
  // the folder simply stops being listed — no tombstone, because nothing was
  // deleted. Its notes leave via their own `revoked` entries below, and without
  // this rule the emptied directory stayed in the sidebar forever ("Getting
  // Started", contents gone, folder still there) and the outbound half kept
  // re-adopting its hidden id on every pull.
  //
  // Same gates as a note revocation: the id must be one WE recorded (a folder
  // with no server id was never agreed ours — absence then proves nothing), the
  // server must have answered about deletions at all (`null` tombstones means
  // "I don't know", and a truncated listing looks exactly like a mass revoke),
  // and the path must not have been re-created server-side under a fresh id.
  // Removal is still empty-only, so a folder holding anything the note pass
  // refused to trash stays on disk. Capped like note revocations.
  if (input.folderTombstones && input.serverFolderIds && input.localFolderIds) {
    const revoked: string[] = [];
    for (const [path, id] of input.localFolderIds) {
      if (input.serverFolderIds.has(id)) continue; // listed (or moved) — handled above
      if (input.folderTombstones.has(id)) continue; // deleted — handled above
      if (!localFoldersCi.has(path.toLowerCase())) continue; // already gone locally
      if (serverFoldersCi.has(path.toLowerCase())) continue; // re-created server-side
      if (!isSafeFolderPath(path)) {
        plan.rejected.push({
          kind: "folder",
          path,
          docId: null,
          reason: "unsafe local folder path",
        });
        continue;
      }
      revoked.push(path);
    }
    // The folder lift is narrower than the note one: it needs authority that
    // named NOTHING. A pass carrying a named list has a doc-level cross-check
    // behind it (`needsAccessCheck`) that folders have no equivalent of — folder
    // ids are not doc ids, so neither `ready.revoked` nor the access-check route
    // can speak about them — so a named pass keeps the folder cap.
    //
    // What makes the remainder acceptable either way: removal is EMPTY-ONLY.
    // `plan.removeFolders` reaches `ipc.deleteFolderIfEmpty`, which is
    // `remove_dir` and never recursive, so the worst a wrong folder revocation
    // can do is take away directories that hold nothing. Any folder still
    // holding a note the note pass refused to trash stays on disk.
    const cap = revokeCap(input.localFolderIds.size);
    const folderLift = input.authoritative === true && input.authoritativeRevoked === undefined;
    if (!folderLift && revoked.length > cap) {
      for (const path of revoked) {
        plan.rejected.push({
          kind: "folder",
          path,
          docId: null,
          reason: `refused: ${revoked.length} folder access removals in one pass exceeds the ${cap} safety limit`,
        });
      }
    } else {
      plan.removeFolders.push(...revoked);
    }
  }
  // Children before parents, so an emptied subtree unwinds bottom-up.
  plan.removeFolders.sort((a, b) => byDepth(b, a));

  // ---- notes --------------------------------------------------------------
  // Every note path on disk, for the "we lost this doc's local identity" case
  // below. `input.local` is docId → path, so its values are exactly that set.
  const localPaths = new Set([...input.local.values()].map((p) => p.toLowerCase()));
  const docIds = new Set<string>([...input.baseline.keys(), ...input.server.keys()]);
  for (const docId of docIds) {
    const prev = input.baseline.get(docId);
    const srv = input.server.get(docId);
    const loc = input.local.get(docId);
    const dead = input.tombstones?.has(docId) ?? false;

    if (srv !== undefined) {
      // Already where the server wants it (or we've never seen this doc, in which
      // case the existing materialize step writes it). Nothing to do.
      //
      // Compared case-insensitively, because the filesystem is: `community/a.md`
      // and `Community/a.md` are ONE file on macOS and Windows, so a spelling
      // disagreement with the server is not a move and renaming to "fix" it
      // moves the file onto itself. After migration 023 merged the
      // case-duplicated server rows, a vault that had them disagrees on exactly
      // that for every merged note — 164 renames a pass, each one a no-op or a
      // refusal, on top of the re-registration wave. The server's own uniqueness
      // is case-insensitive now too, so nothing is lost by matching it here.
      if (loc === undefined || samePath(loc, srv)) continue;
      if (prev === undefined) {
        // On disk under one path, on the server under another, and no baseline to
        // say which one moved. Leave it: without a prior agreement, "the server
        // moved it" and "we've never reconciled this doc" look identical, and
        // guessing here would rename a file on a hunch.
        continue;
      }
      if (samePath(loc, prev)) {
        // The server moved it and we didn't. THE rename-duplicate fix.
        pushRename(plan, docId, loc, srv);
      } else if (samePath(srv, prev)) {
        // We moved it and the server didn't — outbound's job (`renamePath`), not
        // ours. Left alone rather than dragged back.
        continue;
      } else {
        // Both moved, to different places. The vault feed is downstream-only
        // (spec 05), so the server wins. Non-destructive by construction: Rust
        // refuses a rename onto an existing file, so this can never overwrite.
        pushRename(plan, docId, loc, srv);
      }
      continue;
    }

    // Gone from the server's listing.
    if (prev === undefined) continue; // never agreed it was ours — not ours to touch

    if (dead) {
      if (loc === undefined) {
        // No local doc with this id. Usually that means the file really is gone
        // and the prune tidies the map — but it ALSO happens when the file is
        // still sitting at its baseline path under a different local identity
        // (a materialized note whose registry mapping has since been pruned).
        // Re-registering that file is what resurrects a deleted note under a new
        // docId, so suppress the path. Deliberately no trash: without a docId
        // match we can't prove the file at that path is still this note, and a
        // wrong guess here deletes someone's work. It stays on disk as a purely
        // local note the user can remove themselves.
        if (prev !== undefined && localPaths.has(prev.toLowerCase())) {
          plan.suppress.add(prev);
          plan.stubs.push(prev);
        }
        continue;
      }
      // Belt as well as braces: if the trash step is skipped or fails, this still
      // stops the note being re-registered as a ghost.
      plan.suppress.add(loc);
      pushTrash(plan, docId, loc, "deleted", true);
      continue;
    }

    // Absent from BOTH lists ⇒ we lost access. What follows from that is the
    // `suppress` entry (stop re-registering the file) and the `revoked` trash
    // entry below; there is deliberately no separate set of revoked ids, because
    // nothing downstream ever read one.
    if (loc !== undefined) plan.suppress.add(loc);
    // …and the local copy goes with it. A revocation that leaves a full,
    // readable `.md` on the ex-reader's disk is cosmetic: they can open it in
    // any editor forever. So the file is REMOVED OUTRIGHT, not trashed — a copy
    // under `.context/trash` would hand back the very thing being taken away.
    // The content is not lost: this only ever runs for a doc we previously
    // AGREED was server-owned (`prev !== undefined` above), so the server holds
    // every byte and restoring access brings it straight back. The executor
    // still refuses any doc whose content this device never confirmed upstream.
    //
    // The one exception is a note the LOCAL user wrote. Authorship does not
    // survive an item-Private server-side, so their own note can genuinely be
    // revoked — but taking someone's own writing off their disk with no undo is
    // a different act from taking back something they were merely shown.
    //
    // Gated on the server having actually ANSWERED about deletions. A `null`
    // tombstone list means "I don't know", and absence is then uninformative —
    // it could equally be a truncated response. Removing files on the strength
    // of a maybe is precisely the mistake this module exists to avoid.
    if (loc !== undefined && input.tombstones !== null) {
      pushTrash(plan, docId, loc, "revoked", input.authoredByMe?.has(docId) === true);
    }
  }

  // Trash deepest-first, so a folder's contents leave before anything prunes it.
  plan.trash.sort((a, b) => b.path.split("/").length - a.path.split("/").length);

  applyBreakers(
    plan,
    input.baseline.size,
    input.authoritative === true,
    input.authoritativeRevoked ?? null,
  );
  return plan;
}

function pushRename(plan: InboundPlan, docId: string, from: string, to: string): void {
  if (from === to) return;
  if (!isSafeNotePath(to)) {
    plan.rejected.push({ kind: "rename", path: to, docId, reason: "unsafe path from server" });
    return;
  }
  plan.renames.push({ docId, from, to });
}

function pushTrash(
  plan: InboundPlan,
  docId: string,
  path: string,
  reason: InboundTrash["reason"],
  recoverable: boolean,
): void {
  if (!isSafeNotePath(path)) {
    plan.rejected.push({ kind: "trash", path, docId, reason: "unsafe local path" });
    return;
  }
  plan.trash.push({ docId, path, reason, recoverable });
}

function applyBreakers(
  plan: InboundPlan,
  mapped: number,
  authoritative: boolean,
  namedRevoked: ReadonlySet<string> | null,
): void {
  // Each reason is capped against its own budget, and independently: a mass
  // revoke must not blow away the allowance for a legitimate single delete
  // riding in the same pass.
  //
  // On an AUTHORITATIVE pass the revocation budget is lifted (see
  // `InboundInput.authoritative`): the cap's whole job is to disbelieve a
  // shrunken listing, and here the listing is the server's completed answer to
  // "what may this user read now". The DELETION budget is never lifted — that
  // one guards work, not access.
  //
  // When the server also NAMED the revoked docs (`InboundInput.authoritativeRevoked`)
  // the lift is narrowed to those, so a listing that shrinks with nothing
  // announcing those particular docs still hits the cap. The named entries are
  // taken out of the group BEFORE it is measured, so they cannot push the rest
  // over their own limit.
  //
  // Nothing lifted here is FINAL. Every entry the lift saves is recorded in
  // `plan.needsAccessCheck`, and the executor has to get a second, differently
  // computed answer (`effectivePermission`, per doc) before it removes any of
  // them — because the names and the absences both come from one server
  // function, and a pass authorised past its own safety limit deserves a source
  // that could disagree.
  // How large the revoked group is BEFORE anything is refused. Measuring after
  // the refusal was a hole: when the unnamed half blows its own cap and is
  // dropped, the named survivors can fall back under the cap and skip the second
  // opinion — even though the lift is the only reason they are still here. 45
  // named out of 100 mapped was 45 files deleted with no corroboration at all.
  const allRevoked = plan.trash.filter((t) => t.reason === "revoked").length;
  const exempt = authoritative
    ? namedRevoked === null
      ? (t: InboundTrash) => t.reason === "revoked"
      : (t: InboundTrash) => t.reason === "revoked" && namedRevoked.has(t.docId)
    : () => false;
  const caps: Array<[InboundTrash["reason"], number, string]> = [
    ["deleted", trashCap(mapped), "deletions"],
    ["revoked", revokeCap(mapped), "access removals"],
  ];
  for (const [reason, cap, label] of caps) {
    const group = plan.trash.filter((t) => t.reason === reason && !exempt(t));
    if (group.length <= cap) continue;
    const refused = new Set(group);
    for (const t of group) {
      plan.rejected.push({
        kind: "trash",
        path: t.path,
        docId: t.docId,
        reason: `refused: ${group.length} ${label} in one pass exceeds the ${cap} safety limit`,
      });
    }
    plan.trash = plan.trash.filter((t) => !refused.has(t));
  }
  // Which survivors owe the executor a second opinion. The question is whether
  // the group AS PLANNED needed the lift — not whether what is left of it still
  // looks large — so every surviving revoked entry is flagged whenever the
  // original group was over the cap. A small revocation, one that needed no lift
  // at all, still costs no round trip.
  if (allRevoked > revokeCap(mapped)) {
    plan.needsAccessCheck = plan.trash
      .filter((t) => t.reason === "revoked")
      .map((t) => t.docId);
  }
  const rCap = renameCap(mapped);
  if (plan.renames.length > rCap) {
    for (const r of plan.renames) {
      plan.rejected.push({
        kind: "rename",
        path: r.to,
        docId: r.docId,
        reason: `refused: ${plan.renames.length} moves in one pass exceeds the ${rCap} safety limit`,
      });
    }
    plan.renames = [];
  }
}
