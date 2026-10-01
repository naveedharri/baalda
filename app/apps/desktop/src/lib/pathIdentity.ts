// Two answers every sync layer needs about a vault path, kept dependency-free so
// the pure planners (`sync/inbound.ts`, `sync/binaryDeletes.ts`) can import
// them without pulling in the format registry's CodeMirror languages.
//
//   · is this the SAME path as that one? (`pathKey` / `samePathKey`)
//   · is this a file an app left next to a document it holds open, rather than
//     one of the user's files? (`isTransientFileName`)

/**
 * The comparison key for a vault-relative path: Unicode NFC, then lowercased.
 *
 * Lowercased because the filesystems we ship on are case-insensitive (APFS,
 * NTFS) and the server's `lower(path)` unique indexes agree (migration 023).
 *
 * NFC because macOS hands out names in DECOMPOSED form (NFD: `e` + U+0301)
 * where Windows and Linux keep what was typed, usually COMPOSED (NFC: U+00E9).
 * On APFS the two spellings open the same file; byte-compared, they are two
 * paths, so a Mac-created `Café.md` reached a Windows device as a server path
 * that matched no file on its disk — an unmapped local file, a second
 * registration, a failed read for the mapped doc (#259).
 *
 * A KEY, never a rewrite: the bytes on disk and the spelling the server stores
 * stay exactly as they are, and file I/O always uses the original string.
 */
export function pathKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

/** Do two vault paths name the same file? See {@link pathKey}. */
export function samePathKey(a: string, b: string): boolean {
  return a === b || pathKey(a) === pathKey(b);
}

/**
 * Name prefixes of the lock/owner files other apps leave beside a document they
 * hold open (#265): Office's `~$Report.docx`, LibreOffice's `.~lock.Report.docx#`.
 *
 * ONE CONTRACT with Rust `vault.rs TRANSIENT_PREFIXES` — the tree walk and the
 * watcher never report these, and `__tests__/formatsLockstep.test.ts` fails if
 * the two lists drift. The server refuses to register them too
 * (`registry/transient.ts`), so an older client cannot sync them either.
 */
export const TRANSIENT_PREFIXES = ["~$", ".~lock."];

/**
 * Is this file NAME an app's transient lock or temp file? The prefixes above,
 * plus Office's `~*.tmp` save scratch (`~WRL0001.tmp`). A user's own
 * `~notes.md` is theirs.
 *
 * Asked ONLY of binaries (the blob mirror's paths), which is where Rust
 * `vault.rs is_transient_name` applies the prefixes too: it restricts them to
 * surfaced non-note files, so a note or folder named `~$…` keeps syncing.
 * Never a reason to delete anything — a match only stops a NEW upload or a
 * download of somebody's lock file.
 */
export function isTransientFileName(name: string): boolean {
  if (TRANSIENT_PREFIXES.some((p) => name.startsWith(p))) return true;
  return name.startsWith("~") && name.length > 5 && name.toLowerCase().endsWith(".tmp");
}

/** Is the FILE NAME (last segment) of this vault-relative binary path transient? */
export function isTransientPath(relPath: string): boolean {
  const name = relPath.split(/[\\/]/).pop() ?? "";
  return name !== "" && isTransientFileName(name);
}
