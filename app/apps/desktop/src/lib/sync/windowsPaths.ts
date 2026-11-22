// Server paths a Windows disk cannot hold as spelled.
//
// Win32 silently strips a trailing dot or space from every name segment,
// refuses reserved device names (CON, AUX, NUL, PRN, COM1-9, LPT1-9, with or
// without an extension) and the characters < > : " | ? *, and without the
// long-path opt-in refuses anything past MAX_PATH (260). A server row with such
// a name either fails to materialize on every pull or lands under a STRIPPED
// name the watcher then reports as a folder nobody asked for. Either way the
// item cannot exist on this disk as the server spells it, so the inbound side
// skips it deterministically (once-per-session warning) instead of retrying.

const RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[<>:"|?*\u0000-\u001f]/;

/**
 * Longest vault-relative path we materialize on Windows. MAX_PATH is 260
 * including the vault root (`C:\Users\<name>\Documents\Baalda Vaults\<vault>\`,
 * typically 40-60 chars) and the NUL; 200 leaves room for that root.
 */
export const WINDOWS_MAX_REL_PATH = 200;

export type WindowsPathProblem = "trailing-dot-or-space" | "reserved-name" | "forbidden-char" | "too-long";

/** Why `relPath` cannot exist on a Windows disk as spelled, or null if it can. */
export function windowsPathProblem(relPath: string): WindowsPathProblem | null {
  for (const seg of relPath.split("/")) {
    if (!seg) continue;
    if (/[. ]$/.test(seg)) return "trailing-dot-or-space";
    if (RESERVED.test(seg) || RESERVED.test(seg.replace(/[. ]+$/, ""))) return "reserved-name";
    if (FORBIDDEN.test(seg)) return "forbidden-char";
  }
  if (relPath.length > WINDOWS_MAX_REL_PATH) return "too-long";
  return null;
}

/** How Windows would spell `relPath` on disk: trailing dots/spaces stripped per segment. */
export function windowsStrip(relPath: string): string {
  return relPath
    .split("/")
    .map((s) => s.replace(/[. ]+$/, ""))
    .join("/");
}

/** True on a Windows host. Read from the user agent like `lib/platform.ts`. */
export function isWindowsHost(): boolean {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return /Windows/.test(ua);
}

/**
 * Session-scoped skip list: answers "skip this path on this OS?" and warns once
 * per path. `windows` is injectable for tests.
 */
export class UnmaterializablePaths {
  private warned = new Set<string>();
  constructor(
    private readonly windows: () => boolean = isWindowsHost,
    /** The vault's sync rules (#401): a path they hide is no path at all on
     *  this device, exactly like one Windows cannot hold — never created,
     *  written, downloaded or moved to. Silent: it is a choice, not a fault. */
    private readonly excluded: (relPath: string) => boolean = () => false,
  ) {}

  skip(relPath: string): boolean {
    if (this.excluded(relPath)) return true;
    if (!this.windows()) return false;
    const problem = windowsPathProblem(relPath);
    if (!problem) return false;
    if (!this.warned.has(relPath)) {
      this.warned.add(relPath);
      console.warn(`[sync] skipping "${relPath}": Windows cannot hold this name (${problem})`);
    }
    return true;
  }

  /**
   * Outbound twin of {@link skip}: is `localPath` the materialized form of a
   * server item Windows had to strip? The leftover `X` beside server `X.` (a
   * 0.1.84 build created it): registering it, or anything under it, would mint
   * a SECOND server item for what is really the first. `index` comes from
   * {@link strippedServerIndex}. Warns once per local path; never true off Windows.
   */
  skipShadow(localPath: string, index: ReadonlyMap<string, string>): boolean {
    if (!this.windows() || index.size === 0) return false;
    const segs = pathKeyOf(localPath).split("/");
    for (let i = segs.length; i > 0; i--) {
      const server = index.get(segs.slice(0, i).join("/"));
      if (server === undefined) continue;
      if (!this.warned.has(localPath)) {
        this.warned.add(localPath);
        console.warn(`[sync] not registering "${localPath}": it is this disk's spelling of server "${server}"`);
      }
      return true;
    }
    return false;
  }
}

function pathKeyOf(p: string): string {
  return p.normalize("NFC").toLowerCase();
}

/**
 * Server paths whose Windows spelling differs from the server's, keyed by the
 * stripped spelling (NFC, lower-cased, like `pathIdentity.ts pathKey`), valued
 * by the server path. Empty off Windows-unsafe names, so the check is free.
 */
export function strippedServerIndex(serverPaths: Iterable<string>): Map<string, string> {
  const all = [...serverPaths];
  // A stripped spelling the server ALSO holds as a real item (`X.` beside `X`)
  // is that item's own path: a local `X/new.md` under it is new work, not a twin.
  const real = new Set(all.map(pathKeyOf));
  const out = new Map<string, string>();
  for (const p of all) {
    const stripped = windowsStrip(p);
    if (stripped === p) continue;
    const key = pathKeyOf(stripped);
    if (real.has(key)) continue;
    out.set(key, p);
  }
  return out;
}

/** The slice of a bootstrap entry/outcome this filter reads (`ipc.ts`). */
interface DocEntry {
  docId: string;
  relPath: string;
}
interface DocOutcome {
  docId: string;
  status: string;
  reason: string | null;
}

/**
 * Wrap `ipc.applyBootstrapBatch` so an entry this OS cannot hold never reaches
 * Rust: Win32 would strip `X.` to `X` and WRITE the note there, under a folder
 * the server never had. Callers match outcomes by `docId` (`bootstrap.ts settle`,
 * `deferredArrival.ts`), so a skipped entry answers `rejected` in place — the
 * same verdict Rust gives a refused path — and its cold apply finds no path
 * (the store's `resolvePath` skips it too) and writes nothing.
 */
export async function applySkippingUnsafe<E extends DocEntry, O extends DocOutcome>(
  entries: E[],
  apply: (safe: E[]) => Promise<O[]>,
  paths: UnmaterializablePaths,
): Promise<O[]> {
  const safe: E[] = [];
  const skipped: O[] = [];
  for (const e of entries) {
    if (paths.skip(e.relPath)) {
      skipped.push({ docId: e.docId, status: "rejected", reason: "Windows cannot hold this name" } as O);
    } else {
      safe.push(e);
    }
  }
  if (skipped.length === 0) return apply(entries);
  const applied = safe.length > 0 ? await apply(safe) : [];
  return [...applied, ...skipped];
}
