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
   * They execute identically (release the doc, move it to the vault trash) but
   * carry different risk, so they get separate safety caps and separate
   * wording when one is refused. A wrong `deleted` is a server bug destroying
   * work; a mass `revoked` is a routine admin action that happens to look the
   * same from here.
   */
  reason: "deleted" | "revoked";
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
   * Local folder paths the server has DELETED (tombstoned by id), children
   * before parents. The executor removes each one only if it is empty by then —
   * the notes inside leave via their own tombstones in {@link trash} first, and
   * a folder still holding anything (an unconfirmed orphan, a stray image, a
   * new local note) stays on disk and re-registers under a fresh id, which is
   * the safe direction: content must live somewhere.
   */
  removeFolders: string[];
  renames: InboundRename[];
  trash: InboundTrash[];
  /**
   * Docs that vanished from the server listing WITHOUT a tombstone — i.e. access
   * was revoked. This stops us treating them as ours; the file itself leaves via
   * a `revoked` entry in {@link trash}, which is gated on the server having
   * answered about deletions at all.
   */
  revoked: Set<string>;
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
 * affordable because the blast radius is smaller: the server still holds every
 * one of these docs by definition, and the files land in the vault's trash.
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
    revoked: new Set(),
    suppress: new Set(),
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
  for (const path of input.serverFolders) {
    if (input.localFolders.has(path)) continue;
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

  // A local folder whose recorded server id is tombstoned was deleted remotely.
  // Gated on the id match (a same-path successor has a fresh id and never
  // matches) and on the path not having been re-created on the server since.
  if (input.folderTombstones && input.localFolderIds) {
    for (const [path, id] of input.localFolderIds) {
      if (!input.folderTombstones.has(id)) continue;
      if (!input.localFolders.has(path)) continue; // already gone locally
      if (input.serverFolders.has(path)) continue; // re-created server-side
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
  // Children before parents, so an emptied subtree unwinds bottom-up.
  plan.removeFolders.sort((a, b) => byDepth(b, a));

  // ---- notes --------------------------------------------------------------
  // Every note path on disk, for the "we lost this doc's local identity" case
  // below. `input.local` is docId → path, so its values are exactly that set.
  const localPaths = new Set(input.local.values());
  const docIds = new Set<string>([...input.baseline.keys(), ...input.server.keys()]);
  for (const docId of docIds) {
    const prev = input.baseline.get(docId);
    const srv = input.server.get(docId);
    const loc = input.local.get(docId);
    const dead = input.tombstones?.has(docId) ?? false;

    if (srv !== undefined) {
      // Already where the server wants it (or we've never seen this doc, in which
      // case the existing materialize step writes it). Nothing to do.
      if (loc === srv || loc === undefined) continue;
      if (prev === undefined) {
        // On disk under one path, on the server under another, and no baseline to
        // say which one moved. Leave it: without a prior agreement, "the server
        // moved it" and "we've never reconciled this doc" look identical, and
        // guessing here would rename a file on a hunch.
        continue;
      }
      if (loc === prev) {
        // The server moved it and we didn't. THE rename-duplicate fix.
        pushRename(plan, docId, loc, srv);
      } else if (srv === prev) {
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
        if (prev !== undefined && localPaths.has(prev)) plan.suppress.add(prev);
        continue;
      }
      // Belt as well as braces: if the trash step is skipped or fails, this still
      // stops the note being re-registered as a ghost.
      plan.suppress.add(loc);
      pushTrash(plan, docId, loc, "deleted");
      continue;
    }

    // Absent from BOTH lists ⇒ we lost access.
    plan.revoked.add(docId);
    if (loc !== undefined) plan.suppress.add(loc);
    // …and the local copy goes with it. A revocation that leaves a full,
    // readable `.md` on the ex-reader's disk is cosmetic: they can open it in
    // any editor forever. The server keeps the content (this only ever runs for
    // a doc we previously AGREED was server-owned — `prev !== undefined` above),
    // the file moves to the vault's recoverable trash rather than being
    // destroyed, and the executor still refuses any doc whose content this
    // device never confirmed upstream.
    //
    // Gated on the server having actually ANSWERED about deletions. A `null`
    // tombstone list means "I don't know", and absence is then uninformative —
    // it could equally be a truncated response. Removing files on the strength
    // of a maybe is precisely the mistake this module exists to avoid.
    if (loc !== undefined && input.tombstones !== null) {
      pushTrash(plan, docId, loc, "revoked");
    }
  }

  // Trash deepest-first, so a folder's contents leave before anything prunes it.
  plan.trash.sort((a, b) => b.path.split("/").length - a.path.split("/").length);

  applyBreakers(plan, input.baseline.size);
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
): void {
  if (!isSafeNotePath(path)) {
    plan.rejected.push({ kind: "trash", path, docId, reason: "unsafe local path" });
    return;
  }
  plan.trash.push({ docId, path, reason });
}

function applyBreakers(plan: InboundPlan, mapped: number): void {
  // Each reason is capped against its own budget, and independently: a mass
  // revoke must not blow away the allowance for a legitimate single delete
  // riding in the same pass.
  const caps: Array<[InboundTrash["reason"], number, string]> = [
    ["deleted", trashCap(mapped), "deletions"],
    ["revoked", revokeCap(mapped), "access removals"],
  ];
  for (const [reason, cap, label] of caps) {
    const group = plan.trash.filter((t) => t.reason === reason);
    if (group.length <= cap) continue;
    for (const t of group) {
      plan.rejected.push({
        kind: "trash",
        path: t.path,
        docId: t.docId,
        reason: `refused: ${group.length} ${label} in one pass exceeds the ${cap} safety limit`,
      });
    }
    plan.trash = plan.trash.filter((t) => t.reason !== reason);
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
