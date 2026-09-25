// Note writes Rust refused because the path is a symbolic link (#216).
//
// The bridge's egest has no handle on the registry, so its adapter records a
// refusal here and `SyncManager.syncFailures()` reports it beside the
// registry's own failures, as an `inbound-blocked` Health issue with code
// `symlink`. A later write that lands clears it. Dependency-free on purpose:
// the bridge adapter and the sync manager both import it.

export interface LinkRefusal {
  path: string;
  docId: string | null;
}

/** The one sentence Health shows for a linked path. */
export const SYMLINK_REFUSAL_REASON =
  "This path is a symbolic link. Baalda does not sync through links.";

/** True for Rust's refusal to write at or through a symbolic link
 *  (`notefile.rs symlink_refusal`). */
export function isSymlinkRefusal(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /symbolic link/i.test(msg);
}

const refused = new Map<string, LinkRefusal>();

/** Remember that a write to `path` was refused as a symbolic link. */
export function noteLinkRefusal(path: string, docId: string | null): void {
  refused.set(path.toLowerCase(), { path, docId });
}

/** A write to `path` landed: it is no longer a link. */
export function clearLinkRefusal(path: string): void {
  refused.delete(path.toLowerCase());
}

/** Every standing refusal, in path order. */
export function linkRefusals(): LinkRefusal[] {
  return [...refused.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Vault switch / sign-out: refusals belong to one vault. */
export function resetLinkRefusals(): void {
  refused.clear();
}
