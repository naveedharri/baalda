//! Filesystem mutations. Rust owns all disk I/O; every path is validated to
//! stay inside the vault before touching the filesystem. Writes are atomic
//! (temp file + rename) so a crash mid-save never truncates a note.

use crate::error::{io_ctx, AppError, AppResult};
use crate::vault::{require_vault_root, resolve_in_vault, vault_path_state, PathState};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// A UNIQUE sibling temp path for an atomic write.
///
/// Every atomic write in this file (and in `attachments.rs`) is temp + rename,
/// and the temp name used to be `.{file_name}.tmp` — ONE name per target. Two
/// writers of the same file then `write` that same temp path concurrently and
/// the *interleave* of their two contents is what the rename publishes over the
/// note; the loser's rename also fails, which surfaces as a spurious "save the
/// note" error and an egest backoff. `write_note` is an async command that does
/// not hold the state mutex, and `drainEgest` has no in-flight guard, so an
/// egest racing a `writeThrough`/materialize is reachable (desktop-audit #7).
///
/// A process-wide counter plus the pid makes the name unique per call, so each
/// writer renames its OWN complete file: the worst outcome becomes "the older
/// content won", never a spliced one.
///
/// The leading dot is load-bearing — `vault.rs is_ignored_name` skips every
/// dot-prefixed name, so the tree walk, the watcher and the index never see
/// these, and a crash between write and rename leaves invisible debris rather
/// than a phantom note.
pub fn temp_sibling(parent: &Path, file_name: &str) -> PathBuf {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    parent.join(format!(".{file_name}.{}.{n}.tmp", std::process::id()))
}

/// Read a `.md` note to a string (vault-relative path).
pub fn read_note(vault: &Path, rel: &str) -> AppResult<String> {
    let abs = resolve_in_vault(vault, rel)?;
    std::fs::read_to_string(&abs).map_err(io_ctx("read the note", &abs))
}

/// The one refusal every note write gives for a linked path (#216). The desktop
/// matches on "symbolic link" to raise an `inbound-blocked` Health issue.
pub fn symlink_refusal(rel: &str) -> AppError {
    AppError::new(format!(
        "This path is a symbolic link. Baalda does not sync through links. ({rel})"
    ))
}

/// What [`write_note_cas`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteNoteOutcome {
    /// The content is on disk.
    Written,
    /// The file no longer hashes to what the caller expected: nothing was
    /// written. The caller must read the newer file and merge it first.
    Stale,
}

/// Atomic write: write to a temp file in the same dir, then rename over the
/// target so readers never observe a half-written file.
pub fn write_note(vault: &Path, rel: &str, content: &str) -> AppResult<()> {
    write_note_cas(vault, rel, content, None).map(|_| ())
}

/// [`write_note`] with an optional compare-and-swap (#216).
///
/// With `expected_sha = Some(h)`, the current file is hashed first (a missing
/// file hashes as the empty string) and the write is skipped with
/// [`WriteNoteOutcome::Stale`] when it differs: the caller's doc last agreed
/// with a different file, so someone else — an external editor, or a second
/// doc on the same inode — wrote newer bytes that a blind rename would lose.
/// The hash-then-rename is not atomic against other processes; it closes the
/// 300 ms window between the bridge's read and its egest, not a microsecond one.
///
/// Links are refused, never written through: a link at the target (the rename
/// would replace it with a second, regular copy) or in any folder above it (the
/// kernel would resolve through it and land on the REAL file, under another
/// note's identity). As defence in depth the canonical parent must also sit
/// inside the canonical vault root — canonicalising BOTH sides keeps a vault
/// opened as `/var/...` (really `/private/var/...` on macOS) writable.
pub fn write_note_cas(
    vault: &Path,
    rel: &str,
    content: &str,
    expected_sha: Option<&str>,
) -> AppResult<WriteNoteOutcome> {
    let abs = resolve_in_vault(vault, rel)?;
    require_vault_root(vault)?;
    let state = vault_path_state(vault, rel);
    match state {
        PathState::Symlink => return Err(symlink_refusal(rel)),
        PathState::Dir => return Err(AppError::new("refusing to write a note over a directory")),
        PathState::Missing | PathState::Regular => {}
    }
    let parent = abs
        .parent()
        .ok_or_else(|| AppError::new("note has no parent directory"))?;
    // Named + logged (`io_ctx`), not a bare `?`: `write_note_if_missing` runs on
    // the join path that #128 failed on, where an unnamed os error 2 could have
    // been any of half a dozen calls.
    std::fs::create_dir_all(parent).map_err(io_ctx("create the folder", parent))?;
    let canon_root = std::fs::canonicalize(vault).map_err(io_ctx("resolve the vault", vault))?;
    let canon_parent =
        std::fs::canonicalize(parent).map_err(io_ctx("resolve the folder", parent))?;
    if !canon_parent.starts_with(&canon_root) {
        return Err(symlink_refusal(rel));
    }

    if let Some(expected) = expected_sha {
        let current = match state {
            PathState::Regular => sha256_file(&abs).map_err(io_ctx("read the note", &abs))?,
            _ => sha256_hex(""),
        };
        if current != expected {
            return Ok(WriteNoteOutcome::Stale);
        }
    }

    let file_name = abs
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::new("invalid file name"))?;
    let tmp = temp_sibling(parent, file_name);

    std::fs::write(&tmp, content.as_bytes()).map_err(io_ctx("write the note", &abs))?;
    // rename is atomic on the same filesystem.
    std::fs::rename(&tmp, &abs).map_err(io_ctx("save the note", &abs))?;
    Ok(WriteNoteOutcome::Written)
}

/// Atomic write of an absolute path, with the data **fsync'd** before the
/// rename. For files that have no second copy anywhere.
///
/// [`write_note`] deliberately skips the fsync: a note's bytes also live in the
/// open Y.Doc and (when synced) on the server, so a crash that loses the tail of
/// a write costs at most a re-egest. `.context/config.json` is the opposite —
/// it is the ONLY copy of the vault's doc-id map, and a rename that lands before
/// its data reaches disk leaves an empty or truncated map, which reads as "this
/// vault knows nothing about its notes" and re-registers the whole vault.
///
/// The caller supplies an absolute path because the one caller writes inside
/// `.context/`, which `resolve_in_vault` is not used for.
pub fn write_atomic_fsync(target: &Path, content: &[u8]) -> AppResult<()> {
    let parent = target
        .parent()
        .ok_or_else(|| AppError::new("target has no parent directory"))?;
    std::fs::create_dir_all(parent)?;
    let file_name = target
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::new("invalid file name"))?;
    let tmp = temp_sibling(parent, file_name);

    {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(content)?;
        // Data on disk BEFORE the rename publishes it.
        f.sync_all()?;
    }
    // Leave no debris behind if the rename fails (a full disk, a permissions
    // change): the stale temp file would otherwise sit in `.context` forever.
    if let Err(e) = std::fs::rename(&tmp, target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(())
}

/// Write a note ONLY if nothing is there yet. Returns true when the file was
/// created, false when it already existed (left byte-for-byte untouched).
///
/// This exists for one caller — the registry materializing a server-only note as
/// an empty placeholder — and for one reason. That caller decides "the server has
/// this note, this device doesn't" from a *list*, and if the list is ever wrong
/// the plain [`write_note`] turns the mistake into silent, unrecoverable data
/// loss: an empty atomic overwrite of a note full of content. It has happened
/// (428 notes, from a lazily-loaded tree the caller mistook for the whole vault).
/// A create-only write makes that class of bug cost nothing.
///
/// `exists()` + write is not atomic, but it does not need to be: the only writer
/// that races here is the same app, and the failure mode this guards against is a
/// wrong *decision*, not a concurrent one.
pub fn write_note_if_missing(vault: &Path, rel: &str, content: &str) -> AppResult<bool> {
    resolve_in_vault(vault, rel)?;
    // `symlink_metadata`, not `exists()` (#216): a link at (or above) this path
    // is invisible to the tree walk, so "already there" would keep a stale doc
    // id mapped to whatever the link points at. Refused outright — never
    // written through and never claimed as created.
    match vault_path_state(vault, rel) {
        PathState::Symlink => return Err(symlink_refusal(rel)),
        PathState::Missing => {}
        PathState::Regular | PathState::Dir => return Ok(false),
    }
    write_note(vault, rel, content)?;
    Ok(true)
}

/// What [`write_note_if_absent_or_empty`] did with one file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteOutcome {
    /// Nothing was there (missing, or a 0-byte placeholder): the content was
    /// written.
    Written,
    /// A non-empty file was already there and its bytes hash EQUAL to the
    /// content: nothing was written, and nothing needed to be.
    Unchanged,
    /// A non-empty file was already there with DIFFERENT bytes: nothing was
    /// written. The caller owns the merge.
    Conflict,
}

/// Write a note only over nothing — a missing file or a 0-byte placeholder —
/// and otherwise report what is there instead of touching it.
///
/// This is the bulk bootstrap's write. Applying a page of server CRDT means
/// materializing N `.md` files from state this device has never seen, and the
/// one thing that must never happen is a server page landing on top of local
/// content. So the decision is made from the FILE, not from a list:
///
/// | on disk                       | outcome     | writes |
/// |-------------------------------|-------------|--------|
/// | missing / 0 bytes             | `Written`   | yes    |
/// | non-empty, sha256 == content  | `Unchanged` | no     |
/// | non-empty, sha256 differs     | `Conflict`  | **no** |
///
/// Strictly stronger than [`write_note_if_missing`], which only refuses to
/// *create* over an existing file, and than `write_note`, which refuses
/// nothing: this refuses ANY content over a differing non-empty file.
///
/// `Unchanged` is not "nothing happened" — it is what makes a crashed bootstrap
/// page idempotent. Files are written before the CRDT rows commit, so a killed
/// process can leave a file with no `yjs_snapshot`; the re-apply must still be
/// allowed to write those rows, or the doc is stranded and the sync channel
/// re-backfills it forever.
///
/// Uses `write_note`'s un-fsync'd temp + rename on purpose: these bytes also
/// live in the Y.Doc and on the server, so a torn tail costs a re-egest.
/// `write_atomic_fsync` is for `.context/*`, which has no second copy.
pub fn write_note_if_absent_or_empty(
    vault: &Path,
    rel: &str,
    content: &str,
) -> AppResult<WriteOutcome> {
    let abs = resolve_in_vault(vault, rel)?;
    // One stat answers both "is it there" and "is it empty", and a missing file
    // is not an error here — it is the common case.
    let size = match std::fs::metadata(&abs) {
        Ok(m) if m.is_dir() => {
            return Err(AppError::new("refusing to write a note over a directory"))
        }
        Ok(m) => m.len(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
        Err(e) => return Err(io_ctx("read the note", &abs)(e)),
    };
    if size == 0 {
        write_note(vault, rel, content)?;
        return Ok(WriteOutcome::Written);
    }
    // Hashed, not compared byte-for-byte in memory: the incoming content is
    // already a String, but the file may be a 10 MB note and `sha256_file`
    // streams it.
    let on_disk = sha256_file(&abs).map_err(io_ctx("read the note", &abs))?;
    if on_disk == sha256_hex(content) {
        Ok(WriteOutcome::Unchanged)
    } else {
        Ok(WriteOutcome::Conflict)
    }
}

/// Create a new empty note. `parent_rel` is "" for the vault root. Returns the
/// new note's vault-relative path. Fails if it already exists.
pub fn create_note(vault: &Path, parent_rel: &str, name: &str) -> AppResult<String> {
    let name = ensure_md_extension(name)?;
    let rel = join_rel(parent_rel, &name);
    let abs = resolve_in_vault(vault, &rel)?;
    require_vault_root(vault)?;
    if abs.exists() {
        return Err(AppError::new("a note with that name already exists"));
    }
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Create it EMPTY. A note's title is its FILENAME (the UI shows the file
    // stem in the tab, the sidebar and the window), so a seeded `# {stem}` was a
    // visible duplicate of the title the app already shows — and the heading the
    // old title-follow rule renamed the file from. Obsidian-exact: a new note is
    // a blank sheet.
    std::fs::write(&abs, "")?;
    Ok(rel)
}

/// Create a new folder. Returns its vault-relative path.
pub fn create_folder(vault: &Path, parent_rel: &str, name: &str) -> AppResult<String> {
    let rel = join_rel(parent_rel, name);
    let abs = resolve_in_vault(vault, &rel)?;
    require_vault_root(vault)?;
    if abs.exists() {
        return Err(AppError::new("a folder with that name already exists"));
    }
    std::fs::create_dir_all(&abs)?;
    Ok(rel)
}

/// Rename/move a file or folder within the vault. Returns the new rel path.
pub fn rename_path(vault: &Path, old_rel: &str, new_rel: &str) -> AppResult<String> {
    let old_abs = resolve_in_vault(vault, old_rel)?;
    let new_abs = resolve_in_vault(vault, new_rel)?;
    if !old_abs.exists() {
        return Err(AppError::new("source path does not exist"));
    }
    if new_abs.exists() {
        return Err(AppError::new("destination already exists"));
    }
    if let Some(parent) = new_abs.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(&old_abs, &new_abs)?;
    Ok(new_rel.trim_start_matches('/').to_string())
}

/// Create a folder if it isn't already there, including missing parents.
///
/// Distinct from `create_folder`, which fails when the target exists — that's the
/// right behaviour for "New Folder" (the user should not silently land in an
/// existing one) and the wrong behaviour for reconciliation, which runs on every
/// registry change and must be a no-op the second time. Sniffing
/// `create_folder`'s error string across the IPC boundary to tell "already there"
/// from a real failure is how idempotency quietly breaks.
///
/// Returns true when THIS call created the directory, false when it already
/// existed. The caller (an inbound registry pull) uses that to tell a real disk
/// change — one the watcher is about to echo — from a no-op: counting every
/// `ensure_folder` as a change made a pull that changed nothing report "disk
/// changed", re-read the registry, and refresh the whole UI on every pass.
pub fn ensure_folder(vault: &Path, rel: &str) -> AppResult<bool> {
    if crate::vault::rel_path_is_ignored(rel) {
        return Err(AppError::new(
            "refusing to create a folder in an ignored dir",
        ));
    }
    let abs = resolve_in_vault(vault, rel)?;
    require_vault_root(vault)?;
    if abs.is_dir() {
        return Ok(false);
    }
    std::fs::create_dir_all(&abs)?;
    Ok(true)
}

/// Legacy helper that moves a note OUT of the note pipeline into
/// `.context/trash/<stamp>/<rel>`. Returns the trash-relative destination.
///
/// Why `.context` and not the OS trash: `vault::IGNORED_DIRS` keeps `.context` out
/// of the tree walk, the watcher and the index, so a trashed note is recoverable
/// by hand but can never be re-registered. A file restored from the OS trash lands
/// back at its original path, where the watcher indexes it under a FRESH doc_id and
/// the registry pushes it up as a brand-new note — resurrecting something the team
/// deliberately deleted. Invisible-to-the-walk is the property doing the work here.
///
/// `stamp` comes from the caller: there's no date crate in this binary, and one
/// stamp per reconciliation pass keeps a multi-note delete together in one folder.
pub fn trash_note(vault: &Path, rel: &str, stamp: &str) -> AppResult<String> {
    validate_trash_stamp(stamp)?;
    if crate::vault::rel_path_is_ignored(rel) {
        return Err(AppError::new(
            "refusing to trash a path inside an ignored dir",
        ));
    }
    let abs = resolve_in_vault(vault, rel)?;
    if !abs.exists() {
        return Err(AppError::new("path does not exist"));
    }
    // Folders are hard-deleted server-side with no tombstone, so an inbound folder
    // delete is undecidable and never attempted. Refuse loudly rather than let a
    // caller discover that by removing a subtree.
    if abs.is_dir() {
        return Err(AppError::new("refusing to trash a directory"));
    }
    let dest_rel = unique_trash_dest(vault, &format!(".context/trash/{stamp}/{rel}"))?;
    let dest = resolve_in_vault(vault, &dest_rel)?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Same filesystem by construction (.context lives inside the vault), so this
    // rename is atomic. A failure propagates and the caller leaves the file alone,
    // which is the safe outcome.
    std::fs::rename(&abs, &dest)?;
    Ok(dest_rel)
}

/// Write unsendable local `content` into `.context/trash/<stamp>/<rel>`.
///
/// Used when a read-only server state is about to replace divergent local bytes
/// that could not be uploaded. The stamped layout and collision suffix keep
/// repeated recoveries separate.
///
/// Returns the trash-relative destination that was written.
pub fn write_trash_copy(vault: &Path, rel: &str, stamp: &str, content: &str) -> AppResult<String> {
    validate_trash_stamp(stamp)?;
    if crate::vault::rel_path_is_ignored(rel) {
        return Err(AppError::new(
            "refusing to trash a path inside an ignored dir",
        ));
    }
    let dest_rel = unique_trash_dest(vault, &format!(".context/trash/{stamp}/{rel}"))?;
    let dest = resolve_in_vault(vault, &dest_rel)?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Not `write_note`: that resolves a vault-relative path and re-indexes, and
    // nothing inside `.context/` may enter the note pipeline. fsync'd, because
    // this IS the only copy at the instant it is written.
    write_atomic_fsync(&dest, content.as_bytes())?;
    Ok(dest_rel)
}

/// COPY an existing file's bytes into `.context/trash/<stamp>/<rel>`, leaving
/// the source in place. The blob mirror's recovery copy before it replaces a
/// local binary with the server's version — the file itself is about to be
/// overwritten by a download, so moving it (`trash_note`) would leave a gap.
/// Streamed (`fs::copy`), never loaded whole: a binary can be gigabytes.
pub fn copy_to_trash(vault: &Path, rel: &str, stamp: &str) -> AppResult<String> {
    validate_trash_stamp(stamp)?;
    if crate::vault::rel_path_is_ignored(rel) {
        return Err(AppError::new(
            "refusing to trash a path inside an ignored dir",
        ));
    }
    let abs = resolve_in_vault(vault, rel)?;
    if !abs.is_file() {
        return Err(AppError::new("path is not a file"));
    }
    let dest_rel = unique_trash_dest(vault, &format!(".context/trash/{stamp}/{rel}"))?;
    let dest = resolve_in_vault(vault, &dest_rel)?;
    let parent = dest
        .parent()
        .ok_or_else(|| AppError::new("target has no parent directory"))?;
    std::fs::create_dir_all(parent)?;
    let file_name = dest
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::new("invalid file name"))?;
    let tmp = temp_sibling(parent, file_name);
    let result = (|| -> AppResult<()> {
        std::fs::copy(&abs, &tmp)?;
        // This IS the only copy of the local version once the download lands.
        std::fs::File::open(&tmp)?.sync_all()?;
        std::fs::rename(&tmp, &dest)?;
        Ok(())
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(dest_rel)
}

/// The stamp is joined into a path, so it must be exactly one ordinary segment.
fn validate_trash_stamp(stamp: &str) -> AppResult<()> {
    if stamp.is_empty()
        || stamp.starts_with('.')
        || !stamp
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        return Err(AppError::new("invalid trash stamp"));
    }
    Ok(())
}

/// `x.md` → `x (2).md` when the destination inside this stamp is already taken.
fn unique_trash_dest(vault: &Path, rel: &str) -> AppResult<String> {
    if !resolve_in_vault(vault, rel)?.exists() {
        return Ok(rel.to_string());
    }
    let (stem, ext) = match rel.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() && !e.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (rel.to_string(), String::new()),
    };
    for n in 2..1000 {
        let candidate = format!("{stem} ({n}){ext}");
        if !resolve_in_vault(vault, &candidate)?.exists() {
            return Ok(candidate);
        }
    }
    Err(AppError::new("could not find a free name in the trash"))
}

/// Remove a directory ONLY if it is empty by now. Returns whether it was
/// removed; anything still inside (an unconfirmed note, a stray image, a new
/// local file) keeps the folder alive, which is the safe outcome.
///
/// This is the executor for an inbound folder delete: the server tombstones a
/// deleted folder by id, the notes inside leave via their own tombstones, and
/// then this unwinds the emptied directories bottom-up. Deliberately never
/// recursive — `remove_dir`, not `remove_dir_all` — so it can only ever take
/// away a folder that holds nothing.
pub fn delete_folder_if_empty(vault: &Path, rel: &str) -> AppResult<bool> {
    if crate::vault::rel_path_is_ignored(rel) {
        return Err(AppError::new("refusing to touch an ignored dir"));
    }
    let abs = resolve_in_vault(vault, rel)?;
    if !abs.exists() {
        // Already gone — the goal state, but NOT something this call did: the
        // caller counts `true` as a disk change the watcher will echo.
        return Ok(false);
    }
    if !abs.is_dir() {
        return Ok(false); // a file lives at this path; not ours to remove
    }
    // Finder drops a `.DS_Store` into any folder it has shown, and Explorer
    // does the same with `desktop.ini`/`Thumbs.db`. None of those is vault
    // content — the walker never surfaces them — yet `remove_dir` refuses a
    // directory holding one, which is exactly how a folder whose notes had all
    // left kept sitting in the sidebar. Sweep ONLY those names, so a folder that
    // holds anything else still stays put.
    if let Ok(entries) = std::fs::read_dir(&abs) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            if OS_METADATA_FILES.iter().any(|m| name == *m) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    // Any failure (non-empty, permissions, races) means "leave it": a folder
    // that lingers is cosmetic, a reconcile pass that fails over it is not.
    Ok(std::fs::remove_dir(&abs).is_ok())
}

/// Per-folder metadata the OS's file browser writes on its own. Never vault
/// content, so an otherwise-empty folder holding only these counts as empty.
const OS_METADATA_FILES: &[&str] = &[".DS_Store", "desktop.ini", "Thumbs.db"];

/// Delete a file or folder (recursively for folders).
///
/// The recursion is deliberate and is used by exactly one caller: the sidebar's
/// own Delete, where the user picked a folder and meant its contents. Nothing
/// driven by the SERVER may reach it — an inbound removal (a tombstone, a
/// revocation) takes a note path and must be unable to erase a tree even if some
/// later refactor hands it a directory. That caller uses [`delete_file`].
pub fn delete_path(vault: &Path, rel: &str) -> AppResult<()> {
    let abs = resolve_in_vault(vault, rel)?;
    if !abs.exists() {
        return Ok(());
    }
    if abs.is_dir() {
        std::fs::remove_dir_all(&abs)?;
    } else {
        std::fs::remove_file(&abs)?;
    }
    Ok(())
}

/// Delete a single FILE. Refuses a directory outright.
///
/// This is the delete the inbound reconciler uses for confirmed deleted and
/// revoked notes. Neither creates a retained recovery copy.
///
/// Today the paths reaching it come from the local note listing and have already
/// passed `isSafeNotePath`, so none of them is a directory and none of them is
/// under `.context/`. Those are properties of the CALLER, not of this function,
/// and `resolve_in_vault` deliberately permits `.context/` — so one refactor
/// upstream is all it would take for the no-undo delete to become
/// `remove_dir_all` on a tree, or to remove the vault's own doc-id map and CRDT
/// store. Both guards belong here, where they cannot be refactored away from.
pub fn delete_file(vault: &Path, rel: &str) -> AppResult<()> {
    // `.context/`, `.git`, dotfiles — the same refusal `trash_note` and
    // `delete_folder_if_empty` make. Checked BEFORE the directory test, so
    // `.context/config.json` is refused on its own merits rather than surviving
    // because it happens to be a file.
    if crate::vault::rel_path_is_ignored(rel) {
        return Err(AppError::new(format!("refusing to delete an ignored path: {rel}")));
    }
    let abs = resolve_in_vault(vault, rel)?;
    if !abs.exists() {
        return Ok(());
    }
    if abs.is_dir() {
        return Err(AppError::new(format!(
            "refusing to delete a directory as a file: {rel}"
        )));
    }
    std::fs::remove_file(&abs)?;
    Ok(())
}

/// Hex-encoded SHA-256 of a FILE, read in chunks.
///
/// `std::io::copy` into the hasher, deliberately: the tier-2 file index hashes
/// every binary it surfaces, and `fs::read` on a 500 MB video would allocate the
/// whole thing to produce 64 characters. Nothing here holds the index mutex.
pub fn sha256_file(abs: &std::path::Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(abs)?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)?;
    let digest = hasher.finalize();
    let mut s = String::with_capacity(64);
    for b in digest {
        s.push_str(&format!("{b:02x}"));
    }
    Ok(s)
}

/// Hex-encoded SHA-256 of a note's content (echo-suppression aid for the index).
pub fn sha256_hex(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    let digest = hasher.finalize();
    let mut s = String::with_capacity(64);
    for b in digest {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn ensure_md_extension(name: &str) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::new("name cannot be empty"));
    }
    if name.contains('/') || name.contains('\\') {
        return Err(AppError::new("name cannot contain path separators"));
    }
    if name.to_lowercase().ends_with(".md") {
        Ok(name.to_string())
    } else {
        Ok(format!("{name}.md"))
    }
}

fn join_rel(parent_rel: &str, name: &str) -> String {
    let parent = parent_rel.trim_matches('/');
    if parent.is_empty() {
        name.to_string()
    } else {
        format!("{parent}/{name}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// #221: a vault root that moved away while the app was open is never
    /// re-created by a late write — every writer that creates parent folders
    /// refuses instead.
    #[test]
    fn writes_refuse_a_vault_root_that_is_gone() {
        let tmp = tempfile::tempdir().unwrap();
        let v = tmp.path().join("vault");
        std::fs::create_dir_all(&v).unwrap();
        write_note(&v, "Notes/a.md", "# A").unwrap();
        std::fs::rename(&v, tmp.path().join("moved")).unwrap();

        assert!(write_note(&v, "Notes/a.md", "late egest").is_err());
        assert!(write_note_if_missing(&v, "Notes/b.md", "").is_err());
        assert!(create_note(&v, "Notes", "c").is_err());
        assert!(create_folder(&v, "", "New").is_err());
        assert!(ensure_folder(&v, "Other").is_err());
        assert!(!v.exists(), "the old vault folder was not re-created");
    }

    #[test]
    fn delete_file_removes_a_file_and_refuses_a_directory() {
        // The revocation removal is the one delete with no recoverable copy, so
        // it must be structurally incapable of taking a tree with it — including
        // `.context/`, which `resolve_in_vault` deliberately permits.
        let tmp = tempfile::tempdir().unwrap();
        write_note(tmp.path(), "Docs/a.md", "keep me").unwrap();
        write_note(tmp.path(), ".context/config.json", "{}").unwrap();

        delete_file(tmp.path(), "Docs/a.md").unwrap();
        assert!(!tmp.path().join("Docs/a.md").exists());
        // The directory that held it is untouched.
        assert!(tmp.path().join("Docs").is_dir());

        let err = delete_file(tmp.path(), "Docs").unwrap_err();
        assert!(err.0.contains("refusing to delete a directory"), "{}", err.0);
        assert!(tmp.path().join("Docs").is_dir());

        // `.context/` and everything in it, file or directory. The vault's doc-id
        // map and CRDT store live there; the no-undo delete must not be able to
        // reach them even if a caller hands it the path.
        let err = delete_file(tmp.path(), ".context").unwrap_err();
        assert!(err.0.contains("refusing to delete an ignored path"), "{}", err.0);
        let err = delete_file(tmp.path(), ".context/config.json").unwrap_err();
        assert!(err.0.contains("refusing to delete an ignored path"), "{}", err.0);
        assert!(tmp.path().join(".context/config.json").exists());

        // A path that isn't there is a no-op, like `delete_path` — an inbound
        // removal for a file someone already deleted is not an error.
        delete_file(tmp.path(), "Docs/gone.md").unwrap();
    }

    #[test]
    fn delete_path_still_removes_a_directory_tree() {
        // The sidebar's own Delete is the one caller that means it.
        let tmp = tempfile::tempdir().unwrap();
        write_note(tmp.path(), "Docs/sub/a.md", "x").unwrap();
        delete_path(tmp.path(), "Docs").unwrap();
        assert!(!tmp.path().join("Docs").exists());
    }

    #[test]
    fn atomic_write_and_read_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        write_note(tmp.path(), "a/b/note.md", "hello world").unwrap();
        let got = read_note(tmp.path(), "a/b/note.md").unwrap();
        assert_eq!(got, "hello world");
        // No leftover temp file.
        let leftovers: Vec<_> = std::fs::read_dir(tmp.path().join("a/b"))
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn atomic_writes_use_a_unique_temp_name_per_call() {
        // desktop-audit #7: one temp name per target let two concurrent writers
        // of the same note interleave their bytes into one temp file, which the
        // rename then published. The names must differ per call — and stay
        // dot-prefixed, or the tree walk and watcher would surface them.
        let tmp = tempfile::tempdir().unwrap();
        let parent = tmp.path();
        let a = temp_sibling(parent, "note.md");
        let b = temp_sibling(parent, "note.md");
        assert_ne!(a, b, "two temp paths for one target must not collide");
        for path in [&a, &b] {
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            assert!(name.starts_with('.'), "{name} must stay hidden");
            assert!(name.ends_with(".tmp"), "{name} must stay a .tmp");
            assert!(name.contains("note.md"), "{name} must name its target");
            assert!(crate::vault::is_ignored_name(&name), "{name} must be ignored");
        }

        // The real writers pick up the unique name: a write leaves no debris and
        // the content is whole.
        write_note(tmp.path(), "note.md", "one").unwrap();
        write_atomic_fsync(&tmp.path().join(".context/x.json"), b"{}").unwrap();
        let leftovers: Vec<_> = std::fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "no temp files survive a write");
    }

    #[test]
    fn write_if_absent_or_empty_writes_over_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        // Missing.
        assert_eq!(
            write_note_if_absent_or_empty(tmp.path(), "a/Note.md", "server text").unwrap(),
            WriteOutcome::Written
        );
        assert_eq!(read_note(tmp.path(), "a/Note.md").unwrap(), "server text");
    }

    #[test]
    fn write_if_absent_or_empty_fills_a_zero_byte_placeholder() {
        // The 307-stub case: `write_note_if_missing` left these behind, and the
        // bootstrap is what finally fills them.
        let tmp = tempfile::tempdir().unwrap();
        write_note(tmp.path(), "Stub.md", "").unwrap();
        assert_eq!(
            write_note_if_absent_or_empty(tmp.path(), "Stub.md", "hydrated").unwrap(),
            WriteOutcome::Written
        );
        assert_eq!(read_note(tmp.path(), "Stub.md").unwrap(), "hydrated");
    }

    #[test]
    fn write_if_absent_or_empty_reports_identical_bytes_unchanged() {
        // Not an error and not a no-op for the CALLER: this is the re-apply of a
        // page whose files landed but whose CRDT rows never committed.
        let tmp = tempfile::tempdir().unwrap();
        write_note(tmp.path(), "Same.md", "identical").unwrap();
        assert_eq!(
            write_note_if_absent_or_empty(tmp.path(), "Same.md", "identical").unwrap(),
            WriteOutcome::Unchanged
        );
        assert_eq!(read_note(tmp.path(), "Same.md").unwrap(), "identical");
    }

    #[test]
    fn write_if_absent_or_empty_refuses_to_touch_differing_content() {
        // The whole point: a server page never lands on local content.
        let tmp = tempfile::tempdir().unwrap();
        write_note(tmp.path(), "Mine.md", "my local edit").unwrap();
        assert_eq!(
            write_note_if_absent_or_empty(tmp.path(), "Mine.md", "the server's text").unwrap(),
            WriteOutcome::Conflict
        );
        assert_eq!(read_note(tmp.path(), "Mine.md").unwrap(), "my local edit");
        // Empty content over content is refused too (the reverse of the 428-note
        // incident), and traversal never gets that far.
        assert_eq!(
            write_note_if_absent_or_empty(tmp.path(), "Mine.md", "").unwrap(),
            WriteOutcome::Conflict
        );
        assert!(write_note_if_absent_or_empty(tmp.path(), "../escape.md", "x").is_err());
    }

    #[test]
    fn atomic_fsync_write_replaces_content_and_leaves_no_temp_file() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join(".context").join("config.json");

        write_atomic_fsync(&target, br#"{"organizationId":"org-1"}"#).unwrap();
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            r#"{"organizationId":"org-1"}"#
        );

        // Overwrite in place (the doc-id map grows on every registry pull).
        write_atomic_fsync(&target, br#"{"organizationId":"org-1","notes":{}}"#).unwrap();
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            r#"{"organizationId":"org-1","notes":{}}"#
        );

        // The temp file is gone — a `.config.json.tmp` left in `.context` would
        // sit there forever (nothing walks that dir to clean it up).
        let leftovers: Vec<_> = std::fs::read_dir(tmp.path().join(".context"))
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "leftover temp files: {leftovers:?}");
    }

    #[test]
    fn write_note_if_missing_creates_but_never_overwrites() {
        let tmp = tempfile::tempdir().unwrap();

        // Creates, parents and all.
        assert!(write_note_if_missing(tmp.path(), "Context/brand/kit.md", "").unwrap());
        assert_eq!(read_note(tmp.path(), "Context/brand/kit.md").unwrap(), "");

        // A real note is then written there by the user.
        write_note(
            tmp.path(),
            "Context/brand/kit.md",
            "# Brand kit\n\nreal content",
        )
        .unwrap();

        // Materializing it again — the exact call that emptied 428 notes when it
        // was a plain write — reports "already there" and changes nothing.
        assert!(!write_note_if_missing(tmp.path(), "Context/brand/kit.md", "").unwrap());
        assert_eq!(
            read_note(tmp.path(), "Context/brand/kit.md").unwrap(),
            "# Brand kit\n\nreal content"
        );
    }

    #[test]
    fn write_note_if_missing_rejects_traversal() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(write_note_if_missing(tmp.path(), "../escape.md", "x").is_err());
    }

    /// The #216 move-and-link: notes moved from `Old/` to `Business/Old/`, with
    /// `Old -> Business/Old` left behind. A write for the stale identity at
    /// `Old/n.md` used to resolve through the link and replace the REAL file.
    #[cfg(unix)]
    #[test]
    fn write_through_a_folder_link_is_refused_and_leaves_the_real_file() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().unwrap();
        let v = tmp.path();
        write_note(v, "Business/Old/n.md", "newer text").unwrap();
        symlink(v.join("Business/Old"), v.join("Old")).unwrap();

        let err = write_note(v, "Old/n.md", "older text").unwrap_err();
        assert!(err.0.contains("symbolic link"), "{err}");
        let err = write_note(v, "Old/sub/new.md", "x").unwrap_err();
        assert!(err.0.contains("symbolic link"), "{err}");
        assert_eq!(read_note(v, "Business/Old/n.md").unwrap(), "newer text");
        assert!(!v.join("Business/Old/sub").exists());

        let err = write_note_if_missing(v, "Old/n.md", "").unwrap_err();
        assert!(err.0.contains("symbolic link"), "{err}");
        let err = write_note_if_missing(v, "Old/other.md", "").unwrap_err();
        assert!(err.0.contains("symbolic link"), "{err}");
        assert!(!v.join("Business/Old/other.md").exists());
        assert_eq!(read_note(v, "Business/Old/n.md").unwrap(), "newer text");
    }

    #[cfg(unix)]
    #[test]
    fn write_at_a_file_link_neither_replaces_the_link_nor_writes_through_it() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().unwrap();
        let v = tmp.path();
        write_note(v, "Real.md", "real").unwrap();
        symlink(v.join("Real.md"), v.join("Link.md")).unwrap();
        symlink(v.join("Gone.md"), v.join("Dangling.md")).unwrap();

        assert!(write_note(v, "Link.md", "stale").unwrap_err().0.contains("symbolic link"));
        assert!(std::fs::symlink_metadata(v.join("Link.md")).unwrap().file_type().is_symlink());
        assert_eq!(read_note(v, "Real.md").unwrap(), "real");

        // A link is never "already there" for materialize: it is an error.
        assert!(write_note_if_missing(v, "Link.md", "").is_err());
        assert!(write_note_if_missing(v, "Dangling.md", "").is_err());
        assert!(!v.join("Gone.md").exists());
    }

    /// A folder link that escapes the vault is refused even when the leaf name
    /// is fresh, and a vault opened through a non-canonical root (the macOS
    /// temp dir is `/var` → `/private/var`) still writes.
    #[cfg(unix)]
    #[test]
    fn write_refuses_a_parent_outside_the_canonical_root_but_accepts_a_linked_root() {
        use std::os::unix::fs::symlink;
        let outside = tempfile::tempdir().unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("real-vault");
        std::fs::create_dir_all(&real).unwrap();
        symlink(outside.path(), real.join("Out")).unwrap();
        assert!(write_note(&real, "Out/n.md", "x").is_err());
        assert!(!outside.path().join("n.md").exists());

        let linked_root = tmp.path().join("linked-vault");
        symlink(&real, &linked_root).unwrap();
        write_note(&linked_root, "a/b.md", "ok").unwrap();
        assert_eq!(std::fs::read_to_string(real.join("a/b.md")).unwrap(), "ok");
    }

    #[test]
    fn cas_write_refuses_a_file_that_moved_on() {
        let tmp = tempfile::tempdir().unwrap();
        let v = tmp.path();
        // Never observed + missing: the empty-string hash matches.
        assert_eq!(
            write_note_cas(v, "n.md", "first", Some(&sha256_hex(""))).unwrap(),
            WriteNoteOutcome::Written
        );
        // The doc last agreed with "first"; someone wrote "second" since.
        write_note(v, "n.md", "second").unwrap();
        assert_eq!(
            write_note_cas(v, "n.md", "stale", Some(&sha256_hex("first"))).unwrap(),
            WriteNoteOutcome::Stale
        );
        assert_eq!(read_note(v, "n.md").unwrap(), "second");
        assert_eq!(
            write_note_cas(v, "n.md", "merged", Some(&sha256_hex("second"))).unwrap(),
            WriteNoteOutcome::Written
        );
        assert_eq!(read_note(v, "n.md").unwrap(), "merged");
        // None = the unconditional write every other caller makes.
        assert_eq!(write_note_cas(v, "n.md", "blind", None).unwrap(), WriteNoteOutcome::Written);
    }

    #[test]
    fn write_rejects_traversal() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(write_note(tmp.path(), "../escape.md", "x").is_err());
    }

    #[test]
    fn create_note_adds_md_and_refuses_duplicate() {
        let tmp = tempfile::tempdir().unwrap();
        let rel = create_note(tmp.path(), "", "My Note").unwrap();
        assert_eq!(rel, "My Note.md");
        assert_eq!(read_note(tmp.path(), "My Note.md").unwrap(), "");
        assert!(create_note(tmp.path(), "", "My Note").is_err());
    }

    #[test]
    fn create_note_writes_an_empty_file() {
        let tmp = tempfile::tempdir().unwrap();
        let rel = create_note(tmp.path(), "sub", "Blank").unwrap();
        let abs = tmp.path().join(&rel);
        assert_eq!(std::fs::metadata(&abs).unwrap().len(), 0);
    }

    #[test]
    fn rename_moves_file() {
        let tmp = tempfile::tempdir().unwrap();
        write_note(tmp.path(), "a.md", "x").unwrap();
        rename_path(tmp.path(), "a.md", "sub/b.md").unwrap();
        assert!(!tmp.path().join("a.md").exists());
        assert!(tmp.path().join("sub/b.md").exists());
    }

    #[test]
    fn sha_is_stable() {
        assert_eq!(sha256_hex("abc"), sha256_hex("abc"));
        assert_ne!(sha256_hex("abc"), sha256_hex("abd"));
    }

    // ---- trash / ensure_folder --------------------------------------------
    //
    // `trash_note` remains as a legacy recovery primitive. Its path guards stay
    // pinned even though confirmed sync removals now use `delete_file`.

    #[test]
    fn trash_moves_the_note_into_context_and_leaves_no_source() {
        let tmp = tempfile::tempdir().unwrap();
        write_note(tmp.path(), "Notes/bye.md", "real content").unwrap();
        let dest = trash_note(tmp.path(), "Notes/bye.md", "2026-08-07").unwrap();
        assert_eq!(dest, ".context/trash/2026-08-07/Notes/bye.md");
        assert!(!tmp.path().join("Notes/bye.md").exists());
        // Recoverable: the bytes are still there, just outside the note pipeline
        // (`.context` is skipped by the walker, watcher and index, which is what
        // stops a trashed note being re-registered as a ghost).
        let moved = std::fs::read_to_string(tmp.path().join(dest)).unwrap();
        assert_eq!(moved, "real content");
    }

    #[test]
    fn copy_to_trash_keeps_the_source_and_copies_the_bytes() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("Team")).unwrap();
        std::fs::write(tmp.path().join("Team/r.docx"), [1u8, 2, 3]).unwrap();
        let dest = copy_to_trash(tmp.path(), "Team/r.docx", "s1").unwrap();
        assert_eq!(dest, ".context/trash/s1/Team/r.docx");
        assert_eq!(std::fs::read(tmp.path().join("Team/r.docx")).unwrap(), vec![1, 2, 3]);
        assert_eq!(std::fs::read(tmp.path().join(&dest)).unwrap(), vec![1, 2, 3]);
        // A second copy in the same stamp never overwrites the first.
        let again = copy_to_trash(tmp.path(), "Team/r.docx", "s1").unwrap();
        assert_ne!(again, dest);
        assert!(copy_to_trash(tmp.path(), ".context/config.json", "s1").is_err());
        assert!(copy_to_trash(tmp.path(), "Team/missing.docx", "s1").is_err());
    }

    #[test]
    fn trash_disambiguates_a_collision_within_one_stamp() {
        let tmp = tempfile::tempdir().unwrap();
        write_note(tmp.path(), "a.md", "first").unwrap();
        assert_eq!(
            trash_note(tmp.path(), "a.md", "s1").unwrap(),
            ".context/trash/s1/a.md"
        );
        write_note(tmp.path(), "a.md", "second").unwrap();
        assert_eq!(
            trash_note(tmp.path(), "a.md", "s1").unwrap(),
            ".context/trash/s1/a (2).md"
        );
        // Neither copy was overwritten.
        assert_eq!(
            std::fs::read_to_string(tmp.path().join(".context/trash/s1/a.md")).unwrap(),
            "first"
        );
    }

    #[test]
    fn trash_refuses_a_directory() {
        // Folders are hard-deleted server-side with no tombstone, so an inbound
        // folder delete is undecidable and never attempted. Fail loudly rather
        // than let a caller discover that by losing a subtree.
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("Folder")).unwrap();
        assert!(trash_note(tmp.path(), "Folder", "s1").is_err());
        assert!(tmp.path().join("Folder").exists());
    }

    #[test]
    fn trash_refuses_a_path_already_inside_context() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".context")).unwrap();
        std::fs::write(tmp.path().join(".context/config.json"), "{}").unwrap();
        assert!(trash_note(tmp.path(), ".context/config.json", "s1").is_err());
        assert!(tmp.path().join(".context/config.json").exists());
    }

    #[test]
    fn trash_rejects_a_stamp_that_is_not_one_plain_segment() {
        let tmp = tempfile::tempdir().unwrap();
        write_note(tmp.path(), "a.md", "x").unwrap();
        for bad in ["", "a/b", "../..", ".hidden", "a b"] {
            assert!(
                trash_note(tmp.path(), "a.md", bad).is_err(),
                "stamp {bad:?}"
            );
        }
        // Nothing was moved by any of the rejected attempts.
        assert!(tmp.path().join("a.md").exists());
    }

    #[test]
    fn trash_rejects_traversal_and_a_missing_file() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(trash_note(tmp.path(), "../escape.md", "s1").is_err());
        assert!(trash_note(tmp.path(), "nope.md", "s1").is_err());
    }

    // ---- write_trash_copy -------------------------------------------------
    //
    // The recovery copy for local bytes that cannot be synced. `trash_note`
    // renames a source file; this helper writes an explicit snapshot instead.

    #[test]
    fn write_trash_copy_saves_content_for_a_file_that_is_already_gone() {
        let tmp = tempfile::tempdir().unwrap();
        // No source file anywhere: `trash_note` cannot help here.
        assert!(trash_note(tmp.path(), "Notes/bye.md", "s1").is_err());

        let dest = write_trash_copy(tmp.path(), "Notes/bye.md", "s1", "# Bye\n\ntext").unwrap();
        assert_eq!(dest, ".context/trash/s1/Notes/bye.md");
        assert_eq!(
            std::fs::read_to_string(tmp.path().join(".context/trash/s1/Notes/bye.md")).unwrap(),
            "# Bye\n\ntext"
        );
        // Nothing appeared back at the note's own path — a recovery copy stays
        // outside the live note pipeline.
        assert!(!tmp.path().join("Notes/bye.md").exists());
    }

    #[test]
    fn write_trash_copy_disambiguates_within_one_stamp() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(
            write_trash_copy(tmp.path(), "a.md", "s1", "first").unwrap(),
            ".context/trash/s1/a.md"
        );
        assert_eq!(
            write_trash_copy(tmp.path(), "a.md", "s1", "second").unwrap(),
            ".context/trash/s1/a (2).md"
        );
        // The first copy is intact: a second delete of the same path in one
        // window must not overwrite the bytes of the first.
        assert_eq!(
            std::fs::read_to_string(tmp.path().join(".context/trash/s1/a.md")).unwrap(),
            "first"
        );
    }

    #[test]
    fn write_trash_copy_rejects_a_bad_stamp_and_traversal() {
        let tmp = tempfile::tempdir().unwrap();
        for bad in ["", ".", "..", "a/b", "with space", ".hidden"] {
            assert!(
                write_trash_copy(tmp.path(), "a.md", bad, "x").is_err(),
                "stamp {bad:?} should be rejected"
            );
        }
        assert!(write_trash_copy(tmp.path(), "../escape.md", "s1", "x").is_err());
        // A path already inside `.context` would nest the app's own state dir
        // inside the trash.
        assert!(write_trash_copy(tmp.path(), ".context/config.json", "s1", "x").is_err());
    }

    #[test]
    fn ensure_folder_is_idempotent_and_makes_parents() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(ensure_folder(tmp.path(), "A/B/C").unwrap());
        assert!(tmp.path().join("A/B/C").is_dir());
        // Unlike `create_folder`, a second call is a no-op rather than an error —
        // reconciliation runs on every registry change — and says so.
        assert!(!ensure_folder(tmp.path(), "A/B/C").unwrap());
        // On a case-insensitive filesystem a spelling variant IS the same dir, so
        // it too is a no-op — the report must not claim a change that never
        // happened (that claim is what kept a registry pull loop alive, #98).
        if tmp.path().join("a/b/c").is_dir() {
            assert!(!ensure_folder(tmp.path(), "a/b/c").unwrap());
        }
    }

    #[test]
    fn ensure_folder_refuses_ignored_dirs_and_traversal() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(ensure_folder(tmp.path(), ".context/evil").is_err());
        assert!(ensure_folder(tmp.path(), "node_modules/x").is_err());
        assert!(ensure_folder(tmp.path(), "../up").is_err());
    }

    #[test]
    fn delete_folder_if_empty_is_empty_only() {
        let tmp = tempfile::tempdir().unwrap();
        ensure_folder(tmp.path(), "A/B").unwrap();
        std::fs::write(tmp.path().join("A/B/keep.md"), "content").unwrap();
        // Non-empty: stays, reported as not removed.
        assert!(!delete_folder_if_empty(tmp.path(), "A/B").unwrap());
        assert!(tmp.path().join("A/B").is_dir());
        // Emptied: removed, bottom-up.
        std::fs::remove_file(tmp.path().join("A/B/keep.md")).unwrap();
        assert!(delete_folder_if_empty(tmp.path(), "A/B").unwrap());
        assert!(delete_folder_if_empty(tmp.path(), "A").unwrap());
        assert!(!tmp.path().join("A").exists());
        // Already gone is the goal state, not an error — but nothing was removed.
        assert!(!delete_folder_if_empty(tmp.path(), "A").unwrap());
        // A FILE at the path is not ours to remove.
        std::fs::write(tmp.path().join("f.md"), "x").unwrap();
        assert!(!delete_folder_if_empty(tmp.path(), "f.md").unwrap());
        assert!(tmp.path().join("f.md").exists());
        // Ignored dirs and traversal are refused loudly.
        assert!(delete_folder_if_empty(tmp.path(), ".context/trash").is_err());
        assert!(delete_folder_if_empty(tmp.path(), "../up").is_err());
    }

    #[test]
    fn delete_folder_if_empty_treats_os_metadata_as_empty() {
        // Finder had shown the folder, so `.DS_Store` is in it. That is not
        // content: the folder is still removed. Any OTHER dotfile still blocks.
        let tmp = tempfile::tempdir().unwrap();
        ensure_folder(tmp.path(), "Getting Started").unwrap();
        std::fs::write(tmp.path().join("Getting Started/.DS_Store"), b"\0").unwrap();
        assert!(delete_folder_if_empty(tmp.path(), "Getting Started").unwrap());
        assert!(!tmp.path().join("Getting Started").exists());

        ensure_folder(tmp.path(), "Other").unwrap();
        std::fs::write(tmp.path().join("Other/.DS_Store"), b"\0").unwrap();
        std::fs::write(tmp.path().join("Other/.hidden-note"), "mine").unwrap();
        assert!(!delete_folder_if_empty(tmp.path(), "Other").unwrap());
        assert!(tmp.path().join("Other/.hidden-note").exists());
    }
}
