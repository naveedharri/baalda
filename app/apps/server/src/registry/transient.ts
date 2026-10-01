/**
 * Lock and owner files other apps leave beside a document they hold open
 * (#265): Word/Excel/PowerPoint write `~$Report.docx` next to an open
 * `Report.docx` and remove it on close; LibreOffice writes
 * `.~lock.Report.docx#`; Office's save scratch is `~WRL0001.tmp`.
 *
 * The desktop never reports them (Rust `vault.rs is_transient_name`, mirrored
 * by `src/lib/pathIdentity.ts`), but a client that predates that rule still
 * does. Each one used to become a `files` row, an upload, a delete and a
 * tombstone, and a ghost file on every teammate's sidebar.
 *
 * Applied to NEW `files` registrations only (`registerFile`, after the
 * adopt-by-path branch): a row that already exists keeps answering exactly as
 * before, so nothing anyone already has is refused, moved or deleted.
 */
export const TRANSIENT_PREFIXES = ["~$", ".~lock."];

/** Is this file NAME (not a path) an app's transient lock or temp file? */
export function isTransientFileName(name: string): boolean {
  if (TRANSIENT_PREFIXES.some((p) => name.startsWith(p))) return true;
  return name.startsWith("~") && name.length > 5 && name.toLowerCase().endsWith(".tmp");
}

/** Is the last segment of this vault-relative path a transient file name? */
export function isTransientPath(path: string): boolean {
  const i = path.lastIndexOf("/");
  const name = i === -1 ? path : path.slice(i + 1);
  return name !== "" && isTransientFileName(name);
}
