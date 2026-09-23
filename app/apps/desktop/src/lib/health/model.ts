// Vault Health — folding store + sync-layer state into the one report the
// Health tab renders.
//
// Pure and dependency-free, exactly like `syncRollup.ts` and `locks.ts`: plain
// data in, plain data out, no React, no Tauri, no store. Every input is passed
// by the hook (`useVaultHealth.ts`), so the whole verdict is unit-testable and
// so this module can never accidentally acquire a side effect.
//
// THE RULE THIS FILE EXISTS TO KEEP: honesty over optimism. The page is the
// answer to "is my work safe?", so nothing here may report a note as synced
// that nothing confirmed. The counts come straight from `buildTreeSyncIndex` —
// which already refuses to credit an unmapped note, keeps an honest denominator
// and tracks `unreported` separately — rather than being recomputed here, and
// the verdict degrades to the WORST applicable state rather than the friendliest.

import { buildTreeSyncIndex } from "../syncRollup";
// `format.ts` is the one place elapsed time is worded, so the verdict card's
// "Last confirmed …" cannot phrase it differently from the table rows directly
// under it. That module imports a type and nothing else, so this keeps the model
// dependency-free.
import { formatBytes, relativeTime } from "./format";
import { isBulkPhase, type DocSyncState, type SyncProgress } from "../sync/vaultScope";
import type { SyncStatus } from "../sync/syncManager";
import type { AuthStatus } from "../../store";
import type {
  HealthCounts,
  HealthExplanation,
  HealthFact,
  HealthIssue,
  HealthRemedy,
  HealthReport,
  HealthStage,
  HealthStageState,
  HealthVerdict,
  VaultStats,
} from "./types";

// ── Inputs ────────────────────────────────────────────────────────────────────

/** One note's content push that did not land. Mirrors `contentUpload.ts`
 *  `UploadFailure` and the `content` half of `SyncManager.syncFailures()`. */
export interface HealthContentFailure {
  docId: string;
  relPath: string;
  reason: string;
  /** Retrying cannot help without changing the note or its access. */
  permanent?: boolean;
  /** User-facing diagnosis. `permanent` is scheduling metadata, not a cause. */
  kind?: "too-large" | "no-write-access";
}

/** One row the registry could not create/move. Mirrors `registry.ts`
 *  `RegistryFailure`. Kept structural so the model needs no value import from
 *  the sync layer. */
export interface HealthRegistryFailure {
  kind: "folder" | "note" | "materialize" | "inbound" | "inbound-blocked" | "orphan";
  path: string;
  docId: string | null;
  reason: string;
  code: string | null;
}

/** Exactly what `syncManager.syncFailures()` returns. */
export interface HealthFailures {
  registry: HealthRegistryFailure[];
  content: HealthContentFailure[];
  /** The plan limit that stopped the run, if one did. */
  limitCode: string | null;
}

export interface HealthInput {
  /** `store.syncEnabled` — is the sync layer live for this vault? */
  syncEnabled: boolean;
  /** `store.vaultReadySeen` — the one "synced" rule (`TreeSyncInput.serverSettled`):
   *  after the server's first `ready`, a mapped note it did not name is synced. */
  serverSettled?: boolean;
  /** `store.vaultSyncStatus` — the vault channel, independent of note permissions. */
  syncStatus: SyncStatus;
  /** `store.authStatus`. */
  authStatus: AuthStatus;
  /** True once a session object exists (`store.session != null`) — mirrors
   *  `notSyncingReason`'s own check, so a half-established session cannot read
   *  as signed in. */
  hasSession: boolean;
  /** `store.openFolderIsSynced`: the folder's own `.context` stamp, or null
   *  while the peek is still in flight. */
  openFolderIsSynced: boolean | null;
  syncProgress: SyncProgress | null;
  lastSyncedAt: number | null;
  /** `store.serverUrl`; only its host is shown. */
  serverUrl: string;
  now: number;
  /** `store.docIdByPath`. */
  docIdByPath: Record<string, string>;
  /** `store.docSyncState`. */
  docSyncState: Record<string, DocSyncState>;
  /** Every note path the local index knows (`store.titles`). */
  localNotePaths: Iterable<string>;
  failures: HealthFailures;
  /** The Rust census, when it has landed. */
  stats: VaultStats | null;
  /** `store.members` — the vault's roster, used ONLY to name the owner in an
   *  access explanation ("Ask <name> …"). Structural on purpose so the model
   *  needs no value import from `lib/api.ts`; absent ⇒ the explanations fall
   *  back to "the vault's owner". */
  members?: HealthMember[];
}

/** The one shape the model needs out of `api.Member`. */
export interface HealthMember {
  role: string;
  user?: { name: string; email: string };
}

/** Who to ask for access. Null when the roster hasn't loaded or has no owner —
 *  in which case every sentence says "the vault's owner" rather than guessing. */
export function ownerOf(members: HealthMember[] | undefined): {
  name: string;
  email: string;
} | null {
  const owner = members?.find((m) => m.role === "owner");
  const user = owner?.user;
  if (!user) return null;
  const name = user.name.trim() === "" ? user.email : user.name;
  return { name, email: user.email };
}

/** "Ben (ben@example.com)" or "the vault's owner". */
function ownerPhrase(owner: { name: string; email: string } | null): string {
  return owner ? `${owner.name} (${owner.email})` : "the vault's owner";
}

// ── Small text helpers (deliberately `Intl`-free) ─────────────────────────────

/** Thousands separators without pulling in `Intl` — the tests compare strings. */
export function num(n: number): string {
  const s = String(Math.trunc(Math.abs(n)));
  const grouped = s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return n < 0 ? `-${grouped}` : grouped;
}

function plural(n: number, word: string): string {
  return `${num(n)} ${word}${n === 1 ? "" : "s"}`;
}

/** Host of the server this vault syncs against, or null when unparseable. */
export function serverHostOf(serverUrl: string): string | null {
  try {
    const host = new URL(serverUrl).host;
    return host === "" ? null : host;
  } catch {
    return null;
  }
}

// ── Failure → issue mapping ───────────────────────────────────────────────────

/** Plan-limit codes. Only two exist server-side today (`auth/auth.ts`), but any
 *  future `*_limit_reached` is the same conversation with the user. */
export function isLimitCode(code: string | null | undefined): boolean {
  return typeof code === "string" && code.endsWith("_limit_reached");
}

/**
 * The per-note ceiling, mirroring `sync/contentUpload.ts` `MAX_NOTE_BYTES` and
 * the server's `MAX_NOTE_MB`. Mirrored rather than imported because that module
 * pulls in Yjs and the provider, and this one is the dependency-free half that
 * has to stay importable from a plain Node test. **Change one, change both.**
 *
 * It is only a fallback: when the sync layer's own reason carries the cap (it
 * always does today) the issue quotes THAT number, so a server configured with
 * a different `MAX_NOTE_MB` still reads correctly.
 */
export const NOTE_SIZE_LIMIT_MB = 10;

interface TooLargeParse {
  /** Which half is over the cap, per the reason the uploader recorded. */
  cause: "history" | "file" | "unknown";
  /** The measured size in MB, as the uploader formatted it. */
  sizeMb: string | null;
  capMb: string | null;
}

/**
 * Pull the two numbers out of `contentUpload.ts`'s too-large reason so the issue
 * can say "12.4 MB; the limit is 10 MB" in the user's own terms rather than
 * echoing an engineer's sentence. Two shapes exist — the FILE is over the cap,
 * or the doc's edit HISTORY is — and they have different remedies, so they are
 * told apart here rather than merged.
 */
function parseTooLarge(reason: string): TooLargeParse {
  const m = /\(([\d.]+) MB( of edit history)?; the limit is (\d+) MB\)/.exec(reason);
  if (!m) return { cause: "unknown", sizeMb: null, capMb: null };
  const [, size, history, cap] = m;
  return { cause: history ? "history" : "file", sizeMb: size, capMb: cap };
}

/** What the census knows about one note, when the census has landed and the note
 *  is big enough to be in one of its top-10 lists. Both are `null` otherwise —
 *  absence here is "not measured", never "small". */
function censusSizes(
  stats: VaultStats | null,
  path: string | null,
  docId: string | null,
): { fileBytes: number | null; historyBytes: number | null } {
  if (!stats) return { fileBytes: null, historyBytes: null };
  const file = path ? stats.largestNotes.find((n) => n.path === path) : undefined;
  const hist = docId ? stats.heaviestHistory.find((h) => h.docId === docId) : undefined;
  return { fileBytes: file?.bytes ?? null, historyBytes: hist?.bytes ?? null };
}

interface IssueContext {
  stats: VaultStats | null;
  owner: { name: string; email: string } | null;
}

function pathFact(path: string | null): HealthFact[] {
  return path ? [{ label: "Path", value: path }] : [];
}

function docIdFact(docId: string | null): HealthFact[] {
  return docId ? [{ label: "Doc id", value: docId, copyable: true }] : [];
}

function tooLargeIssue(f: HealthContentFailure, ctx: IssueContext): HealthIssue {
  const parsed = parseTooLarge(f.reason);
  const { fileBytes, historyBytes } = censusSizes(ctx.stats, f.relPath, f.docId);
  const capMb = parsed.capMb ? Number(parsed.capMb) : NOTE_SIZE_LIMIT_MB;
  const capBytes = capMb * 1024 * 1024;

  // Three signals, in order of how much they actually know. The uploader's own
  // reason says which half it measured over the cap. The census can then settle
  // the case the reason cannot: a note whose FILE is comfortably under the cap
  // but whose stored edit history is over it is a history problem, and telling
  // someone to "split the note" there would send them to shorten a file that was
  // never the reason. The census never promotes a file to the cause on its own
  // absence — a note missing from the top-10 list is unmeasured, not small.
  let cause: "history" | "file" | "unknown" = parsed.cause;
  if (fileBytes != null && fileBytes > capBytes) cause = "file";
  else if (
    fileBytes != null &&
    fileBytes <= capBytes &&
    historyBytes != null &&
    historyBytes > capBytes
  ) {
    cause = "history";
  }

  const sizeText =
    cause === "file" && parsed.sizeMb
      ? `${parsed.sizeMb} MB`
      : fileBytes != null
        ? formatBytes(fileBytes)
        : null;
  const historyText =
    historyBytes != null
      ? formatBytes(historyBytes)
      : cause === "history" && parsed.sizeMb
        ? `${parsed.sizeMb} MB`
        : null;

  const why =
    cause === "history"
      ? `This note's edit history is ${historyText ?? "over the limit"}; the Remote Vault ` +
        `accepts up to ${capMb} MB per note. The note's own text is not the problem.`
      : cause === "file"
        ? `This note is ${sizeText ?? "over the limit"}; the Remote Vault accepts up to ` +
          `${capMb} MB. It has to get smaller before it can sync.`
        : `The Remote Vault refused this note as too large: ${f.reason}`;

  const meaning =
    cause === "history"
      ? "Every edit Baalda has ever merged into this note is stored alongside it so " +
        "offline changes can merge instead of overwriting. That stored history has " +
        "grown past what the Remote Vault accepts, so the note stops uploading. Your text " +
        "is intact on this device; only the record of past edits is oversized."
      : cause === "file"
        ? "The note itself is bigger than one note is allowed to be on the Remote Vault, " +
          "usually because something large is pasted into the file rather than kept " +
          "beside it. The Remote Vault will not accept it at any size above the limit, so " +
          "it stays on this device only."
        : "The Remote Vault refused this note because of its size. Baalda recorded the " +
          "refusal but not which half was oversized.";

  const fixes =
    cause === "history"
      ? [
          "Reset this note's history — it clears the stored edit history and keeps " +
            "the note's text exactly as it is. This is the fix in almost every case.",
          "If it comes back, something is rewriting this note repeatedly (an " +
            "automation or a script). Stop that first, then reset again.",
        ]
      : cause === "file"
        ? [
            "Move large embedded content (images, PDFs, pasted base64) out of the " +
              "note and into the attachments folder, then link to it.",
            "Split the note into several smaller notes.",
            "Save a copy outside the vault, then shorten the note here.",
          ]
        : [
            "Save a copy outside the vault so you have it, then reset this note's " +
              "history and shorten the note.",
          ];

  const remedies: HealthRemedy[] =
    cause === "history"
      ? ["reset-history", "open", "reveal", "export-copy", "delete", "copy-details"]
      : ["open", "reveal", "export-copy", "reset-history", "delete", "copy-details"];

  const facts: HealthFact[] = [
    ...pathFact(f.relPath),
    { label: "Size", value: sizeText ?? "Not measured on this page" },
    { label: "Limit", value: `${capMb} MB per note` },
    ...(historyText ? [{ label: "History size", value: historyText }] : []),
    ...docIdFact(f.docId),
    { label: "Raw reason", value: f.reason, copyable: true },
  ];

  return {
    key: f.docId,
    docId: f.docId,
    path: f.relPath,
    kind: "too-large",
    severity: "error",
    title: "Too large to sync",
    why,
    remedies,
    code: null,
    explanation: {
      meaning,
      next: "Nothing — Baalda will not retry until the note is smaller.",
      fixes,
      safety: "only-here",
    },
    facts,
    autoRetries: false,
  };
}

/**
 * Turn one of the sync layer's recorded reasons into a sentence that says what
 * actually went wrong. Every shape matched here is a string that exists in
 * `contentUpload.ts` (`fail(...)` call sites) or comes out of `syncManager.ts`,
 * whose terminal statuses reject with the status as the message.
 *
 * Returns null for anything unrecognized — the issue then quotes the raw reason
 * rather than inventing a cause for it.
 */
export function classifyUploadReason(reason: string): string | null {
  const r = reason.trim().toLowerCase();
  if (r.startsWith("open failed")) {
    return (
      "Baalda could not open this note's local copy to send it, so nothing was " +
      "uploaded. That is usually a file permission problem or a note the local " +
      "index and the disk disagree about."
    );
  }
  if (r.includes("did not respond to the initial sync")) {
    return (
      "The connection opened, but the Remote Vault never sent back what it already " +
      "holds for this note. Baalda refuses to upload before it has read the " +
      "Remote Vault's copy, because uploading first is how two versions of a note end " +
      "up merged into one doubled note. Usually the Remote Vault was unreachable or " +
      "too slow."
    );
  }
  if (r.includes("did not acknowledge the content")) {
    return (
      "The content was sent, but the Remote Vault never confirmed it had stored it. " +
      "Baalda will not call a note synced on a guess, so it is reported as " +
      "failed. A dropped connection or an overloaded Remote Vault both look like this."
    );
  }
  if (r === "no-access" || r.includes("403") || r.includes("forbidden")) {
    return (
      "The Remote Vault refused this note: your access to it is view-only, or it has " +
      "been withdrawn. Nothing you type here will reach the Remote Vault until access " +
      "is restored."
    );
  }
  if (r === "deleted" || r.includes("404") || r.includes("not found")) {
    return (
      "The Remote Vault has no record for this note any more — it was deleted there while " +
      "this device still held it. Your copy is untouched on disk."
    );
  }
  if (r === "too-large" || r.includes("too large")) {
    return "The Remote Vault refused this note because it is over the per-note size limit.";
  }
  if (r.includes("401") || r.includes("unauthor")) {
    return (
      "The Remote Vault did not accept this device's sign-in. Signing out and back in " +
      "usually clears it."
    );
  }
  if (/\b5\d\d\b/.test(r) || r.includes("internal server error")) {
    return "The Remote Vault hit an error of its own while storing this note.";
  }
  if (r.includes("timed out") || r.includes("timeout")) {
    return "The Remote Vault took too long to answer, so Baalda stopped waiting.";
  }
  if (
    r.includes("failed to fetch") ||
    r.includes("load failed") ||
    r.includes("network") ||
    r.includes("econnrefused") ||
    r.includes("enotfound") ||
    r.includes("socket")
  ) {
    return "This device could not reach the Remote Vault, so nothing was sent.";
  }
  if (r === "error") {
    return "The connection Baalda opened for this note failed before the content landed.";
  }
  return null;
}

function uploadFailedIssue(f: HealthContentFailure): HealthIssue {
  const cause = classifyUploadReason(f.reason);
  return {
    key: f.docId,
    docId: f.docId,
    path: f.relPath,
    kind: "upload-failed",
    severity: "error",
    title: "Couldn't upload",
    why:
      `This note's content did not reach the Remote Vault. ${capitalize(f.reason)} ` +
      `Its only copy is on this device.`,
    remedies: ["retry", "open", "reveal", "export-copy", "copy-details"],
    code: null,
    explanation: {
      meaning:
        (cause ? `${cause} ` : `Baalda recorded: ${capitalize(f.reason)} `) +
        "The note itself is safe: it is written to disk on this device exactly as " +
        "you left it. What failed is the copy going to the Remote Vault, so your other " +
        "devices and your teammates do not have it yet.",
      next: "Baalda retries on the next connect, and again the next time the file changes.",
      fixes: [
        "Retry now if you want it to go straight away.",
        "Check you are online and that the Remote Vault is reachable.",
        "Save a copy outside the vault if this is work you cannot afford to lose " +
          "while it is only on this device.",
      ],
      safety: "only-here",
    },
    facts: [
      ...pathFact(f.relPath),
      ...docIdFact(f.docId),
      { label: "Last error", value: f.reason, copyable: true },
    ],
    autoRetries: true,
  };
}

function noWriteAccessIssue(f: HealthContentFailure): HealthIssue {
  const saved = f.reason.includes("copy saved to ");
  return {
    key: f.docId,
    docId: f.docId,
    path: f.relPath,
    kind: "no-write-access",
    severity: "error",
    title: "Read-only sync needs review",
    why: saved
      ? "The Remote Vault refused this note as read-only. Baalda kept a recovery copy before restoring the Remote Vault's version."
      : "The Remote Vault refused this note as read-only. Check again to verify whether its current local and remote text already match.",
    remedies: ["retry", "open", "reveal", "export-copy", "copy-details"],
    code: null,
    explanation: {
      meaning:
        "The Remote Vault still has its confirmed copy, but it did not accept this device's submitted state because you do not have write access.",
      next:
        "Check again. If the current text already matches the Remote Vault, the warning clears without changing the note.",
      fixes: saved
        ? [
            "Check again to compare the current read-only copy with the Remote Vault.",
            "Open the recovery copy named in the details and restore the edit after access returns.",
          ]
        : [
            "Check again to compare the current read-only copy with the Remote Vault.",
            "If the warning remains, ask the vault owner for edit access before making changes.",
          ],
      safety: "only-here",
    },
    facts: [
      ...pathFact(f.relPath),
      ...docIdFact(f.docId),
      { label: "Last error", value: f.reason, copyable: true },
    ],
    autoRetries: false,
  };
}

function contentIssue(f: HealthContentFailure, ctx: IssueContext): HealthIssue {
  // The reason fallback keeps reports created by an older running session
  // intelligible across a hot UI update. New producers always set `kind`.
  if (f.kind === "too-large" || f.reason.toLowerCase().includes("too large")) {
    return tooLargeIssue(f, ctx);
  }
  if (f.kind === "no-write-access") return noWriteAccessIssue(f);
  return uploadFailedIssue(f);
}

function capitalize(s: string): string {
  const t = s.trim();
  if (t === "") return "";
  const head = t[0].toUpperCase() + t.slice(1);
  return /[.!?]$/.test(head) ? head : `${head}.`;
}

/**
 * The one-line meaning of each `code` a create/move refusal can carry. These are
 * the only codes the server emits with a body (`http/routes/registry.ts`), and
 * the desktop's `registry.ts errorCode` is what puts them on the failure.
 */
function registerCodeMeaning(code: string | null, kind: "folder" | "note"): string | null {
  switch (code) {
    case "no_write_access":
      return (
        `Your access to this folder is view-only, so the Remote Vault refused to create ` +
        `the ${kind}.`
      );
    case "root_frozen":
      return (
        `This vault's top level is locked, so new items can only be created inside ` +
        `a folder. Move this ${kind} into one and it will register.`
      );
    case "path_folder_mismatch":
      return (
        `The folder this ${kind} sits in on disk and the folder the Remote Vault has ` +
        `recorded for it disagree, so the Remote Vault refused the request rather than ` +
        `guess which one is right.`
      );
    case "doc_id_conflict":
      return (
        `This ${kind}'s id already belongs to a different vault on the Remote Vault, so ` +
        `it cannot be created here under the same id.`
      );
    case "note_deleted":
      return (
        `This ${kind} was deleted on the Remote Vault by another member. Your copy is ` +
        `kept on this device but no longer syncs; delete it, or save its text as a new ` +
        `${kind} to share it again.`
      );
    default:
      return null;
  }
}

function limitIssue(f: HealthRegistryFailure): HealthIssue {
  const member = f.code === "member_limit_reached";
  const notes = f.code === "note_limit_reached";
  return {
    key: f.docId ?? f.path,
    docId: f.docId,
    path: f.path,
    kind: "limit",
    severity: "error",
    title: "Plan limit reached",
    why: notes ? "This Free vault has reached 20,000 synced notes. Upgrade to Pro to sync more. Existing notes keep syncing; additional notes stay on this device." : member
      ? "This vault has as many members as the free plan allows, so the Remote Vault " +
        "refused. Upgrade to add more."
      : "This account has as many vaults as the free plan allows, so the Remote Vault " +
        "refused to create more. Upgrade to keep syncing.",
    remedies: ["upgrade", "copy-details"],
    code: f.code,
    explanation: {
      meaning: notes ? "Free vaults can sync up to 20,000 notes. Your additional notes remain safely on this device." : member
        ? "The free plan allows a limited number of people in one vault. This vault " +
          "is at that number, so the Remote Vault turned this request down. Nothing was " +
          "lost — the work simply stopped at the gate."
        : "The free plan allows a limited number of vaults per account. This account " +
          "is at that number, so the Remote Vault would not create another one. Nothing " +
          "was lost — the work simply stopped at the gate.",
      next: "Nothing — the Remote Vault will refuse this the same way every time until the limit lifts.",
      fixes: [
        notes ? "Upgrade this vault to Pro to sync more than 20,000 notes." : member
          ? "Upgrade this vault to add more people."
          : "Upgrade to create more vaults.",
        member
          ? "Or remove a member you no longer work with, which frees a seat."
          : "Or delete a vault you no longer use, which frees a slot.",
      ],
      safety: "only-here",
    },
    facts: [
      ...pathFact(f.path),
      { label: "Limit", value: member ? "Members per vault" : "Vaults per account" },
      { label: "Remote Vault code", value: f.code ?? "unknown", copyable: true },
    ],
    autoRetries: false,
  };
}

function registryIssue(f: HealthRegistryFailure, ctx: IssueContext): HealthIssue {
  const key = f.docId ?? f.path;
  if (isLimitCode(f.code)) return limitIssue(f);
  if (f.kind === "inbound-blocked") {
    return {
      key,
      docId: f.docId,
      path: f.path,
      kind: "inbound-blocked",
      severity: "error",
      title: "Local change held for safety",
      why: `Baalda kept this item on disk because a sync safety check did not pass. ${capitalize(f.reason)}`,
      remedies: ["retry", "reveal", "copy-details"],
      code: f.code,
      explanation: {
        meaning: "A removal or move requested by the Remote Vault was not applied. This is a safety check, not a failure to write a downloaded note.",
        next: "Baalda checks again on the next sync pass. Items stay here until the required checks pass.",
        fixes: ["Retry sync to check the current access and structure.", "If this repeats, copy the details for investigation before removing local files."],
        safety: "unknown",
      },
      facts: [...pathFact(f.path), ...docIdFact(f.docId), { label: "Safety check", value: f.reason, copyable: true }],
      autoRetries: true,
    };
  }
  if (f.kind === "materialize" || f.kind === "inbound") {
    return {
      key,
      docId: f.docId,
      path: f.path,
      kind: "materialize-failed",
      severity: "error",
      title: "Couldn't write this to disk",
      why:
        `The Remote Vault has this note, but it could not be written into your vault ` +
        `folder. ${capitalize(f.reason)}`,
      remedies: ["retry", "reveal", "copy-details"],
      code: f.code,
      explanation: {
        meaning:
          "This note exists on the Remote Vault and is safe there. What failed is the " +
          "last step: writing it into your vault folder on this device. The usual " +
          "causes are a folder this app is not allowed to write to, a filename this " +
          "operating system will not accept, or a path that has grown too long.",
        next: "Baalda tries again on the next sync pass.",
        fixes: [
          "Check the vault folder is writable and not inside a synced folder that " +
            "locks files (some cloud drives do).",
          "If the name contains characters this system rejects, rename the note on " +
            "another device or on the Remote Vault.",
          "Shorten the folder path if it is very deep.",
        ],
        safety: "on-server",
      },
      facts: [
        ...pathFact(f.path),
        ...docIdFact(f.docId),
        ...(f.code ? [{ label: "Remote Vault code", value: f.code, copyable: true }] : []),
        { label: "Last error", value: f.reason, copyable: true },
      ],
      autoRetries: true,
    };
  }
  if (f.kind === "orphan") {
    // `registry.ts` records `orphan` for a file the server has deleted (or
    // revoked) whose content THIS device never confirmed upstream. It is left on
    // disk on purpose — removing it could destroy the only copy — and it stops
    // claiming its path so a later pass can re-register it.
    return {
      key,
      docId: f.docId,
      path: f.path,
      kind: "left-behind",
      severity: "error",
      title: "Left on disk — not on the Remote Vault",
      why:
        `${capitalize(f.reason)} It was kept here rather than removed, because ` +
        `this device may hold the only copy. Open it to check, then delete it if ` +
        `you don't need it.`,
      remedies: ["open", "reveal", "reregister", "export-copy", "delete", "copy-details"],
      code: f.code,
      explanation: {
        meaning:
          "The Remote Vault no longer has this note. Either someone deleted it, or your " +
          "access to it was withdrawn. Normally Baalda would remove the file here " +
          "to match — but this device never got confirmation that the Remote Vault had " +
          "this note's content, so the copy in front of you may be the only one " +
          "that exists. It was kept on purpose rather than deleted.",
        next: "Nothing. Baalda will not remove it and will not re-upload it on its own.",
        fixes: [
          "Open it and decide whether you still want it.",
          "Put it back on the Remote Vault with Re-register, which creates a fresh note " +
            "from this file and uploads it.",
          "Save a copy outside the vault if you want it kept but not synced.",
          "Delete it once you are sure you do not need it.",
        ],
        safety: "only-here",
      },
      facts: [
        ...pathFact(f.path),
        ...docIdFact(f.docId),
        ...(f.code ? [{ label: "Remote Vault code", value: f.code, copyable: true }] : []),
        { label: "Raw reason", value: f.reason, copyable: true },
      ],
      autoRetries: false,
    };
  }
  const isFolder = f.kind === "folder";
  const what = isFolder ? "folder" : "note";
  const coded = registerCodeMeaning(f.code, isFolder ? "folder" : "note");
  const remedies: HealthRemedy[] = isFolder
    ? ["retry", "reveal", "copy-details"]
    : ["retry", "open", "reveal", "copy-details"];
  if (f.code === "no_write_access") remedies.push("contact-owner");
  return {
    key,
    docId: f.docId,
    path: f.path,
    kind: "register-failed",
    severity: "error",
    title: isFolder ? "Folder couldn't be registered" : "Couldn't be registered",
    why:
      `The Remote Vault has no record for this ${what}, so nothing ` +
      `under it can sync. ${capitalize(f.reason)}`,
    remedies,
    code: f.code,
    explanation: {
      meaning:
        `Before anything can sync, the Remote Vault needs a record that this ${what} ` +
        `exists. That record could not be created, so this ${what} — and, for a ` +
        `folder, everything inside it — stays on this device only. ` +
        (coded ??
          (f.code
            ? `The Remote Vault answered with "${f.code}".`
            : "The Remote Vault did not say why.")) +
        (f.code === "no_write_access"
          ? ` Ask ${ownerPhrase(ctx.owner)} for edit access.`
          : ""),
      next: "Baalda tries again on the next registry pass, which runs on every sync and whenever the folder changes.",
      fixes:
        f.code === "no_write_access"
          ? [
              `Ask ${ownerPhrase(ctx.owner)} to give you edit access to this folder.`,
              "Until then, move the note to a folder you can write to and it will sync from there.",
            ]
          : f.code === "root_frozen"
            ? [`Move this ${what} into a folder instead of the top level of the vault.`]
            : f.code === "path_folder_mismatch"
              ? [
                  `Move the ${what} somewhere else and back, which re-states where it lives.`,
                  "If it persists, report it with Copy details — the two Remote Vault records need reconciling.",
                ]
              : [
                  "Retry now.",
                  "Check you are online and that you still have access to this vault.",
                ],
      safety: "only-here",
    },
    facts: [
      ...pathFact(f.path),
      ...docIdFact(f.docId),
      ...(f.code ? [{ label: "Remote Vault code", value: f.code, copyable: true }] : []),
      { label: "Last error", value: f.reason, copyable: true },
    ],
    autoRetries: true,
  };
}

/** Cap on the `unregistered` warnings emitted. A vault mid-registration can have
 *  thousands; 50 rows say everything 5,000 would, and the total lands in the
 *  report's `detail` instead of in 4,950 DOM nodes. */
export const MAX_UNREGISTERED_ISSUES = 50;

// ── The report ────────────────────────────────────────────────────────────────

function emptyCounts(): HealthCounts {
  return { total: 0, synced: 0, pending: 0, failed: 0, unsynced: 0, unreported: 0 };
}

/**
 * Mirrors `NotSyncingBanner.tsx` `notSyncingReason`'s signed-out half.
 *
 * Duplicated rather than imported: that function lives in a `.tsx` module that
 * imports React, and this one has to stay importable from a Node test with no
 * DOM. The three refusals are the same and must stay in lockstep — a folder that
 * was never a synced vault says nothing, `authStatus: "unknown"` says nothing
 * (it is the window between paint and session restore), and only then is a
 * missing session reported.
 */
function isSignedOutOnSyncedFolder(input: HealthInput): boolean {
  if (input.openFolderIsSynced !== true) return false;
  if (input.authStatus === "unknown") return false;
  return input.authStatus !== "signed-in" || !input.hasSession;
}

export function buildHealthReport(input: HealthInput): HealthReport {
  const serverHost = serverHostOf(input.serverUrl);
  const bulk = isBulkPhase(input.syncProgress?.phase);
  const signedOut = isSignedOutOnSyncedFolder(input);
  const signedIn = input.authStatus === "signed-in" && input.hasSession;

  const index = buildTreeSyncIndex({
    docIdByPath: input.docIdByPath,
    docSyncState: input.docSyncState,
    localNotePaths: input.localNotePaths,
    serverSettled: input.serverSettled === true,
  });
  const v = index.vault;
  const counts: HealthCounts = v
    ? {
        total: v.total,
        synced: v.synced,
        pending: v.pending,
        failed: v.failed,
        unsynced: Math.max(0, v.total - v.synced - v.pending - v.failed),
        unreported: v.unreported,
      }
    : emptyCounts();

  const { issues, unregisteredTotal } = buildIssues(input, {
    bulk,
    signedIn,
    mappedPaths: index.notes,
  });
  const errors = issues.filter((i) => i.severity === "error");

  const verdict = decideVerdict(input, { bulk, signedOut, counts, errors: errors.length });
  const stages = buildStages(input, { verdict, counts, issues, bulk, serverHost });
  const { headline, detail } = describe(input, {
    verdict,
    counts,
    errors: errors.length,
    serverHost,
    unregisteredTotal,
  });

  return {
    verdict,
    headline,
    detail,
    stages,
    counts: input.syncEnabled ? counts : null,
    issues,
    lastSyncedAt: input.lastSyncedAt,
    serverHost: input.syncEnabled ? serverHost : null,
  };
}

// ── Verdict ───────────────────────────────────────────────────────────────────

function decideVerdict(
  input: HealthInput,
  ctx: { bulk: boolean; signedOut: boolean; counts: HealthCounts; errors: number },
): HealthVerdict {
  if (!input.syncEnabled) return "local";
  if (ctx.signedOut) return "signed-out";
  if (input.syncStatus === "no-access") return "no-access";
  // A bulk run outranks the socket statuses, which belong to the OPEN doc and
  // read "offline" whenever no note is on screen — including through the whole
  // of a launch backfill. Work that is demonstrably moving is not offline.
  // (This is the one place the precedence list is reordered, and only here.)
  if (ctx.bulk) return "syncing";
  if (input.syncStatus === "offline") return "offline";
  if (input.syncStatus === "connecting") return "connecting";
  if (ctx.errors > 0 || ctx.counts.failed > 0 || input.syncProgress?.phase === "error") {
    return "attention";
  }
  // Nothing errored, but notes are still not on the server. `healthy` means
  // EVERYTHING confirmed, so this cannot be it — a settled run that left a note
  // behind is precisely the silent divergence this page exists to expose.
  //
  // `unreported` is excluded, and that exclusion is load-bearing: a mapped note
  // nobody has spoken for yet is not work (see `syncRollup.ts`), and counting it
  // would put every fresh launch into `attention` until the first batch of
  // `synced` stamps lands.
  const remaining = ctx.counts.total - ctx.counts.synced - ctx.counts.unreported;
  if (remaining > 0) return "attention";
  return "healthy";
}

// ── Issues ────────────────────────────────────────────────────────────────────

function buildIssues(
  input: HealthInput,
  ctx: { bulk: boolean; signedIn: boolean; mappedPaths: Map<string, DocSyncState> },
): { issues: HealthIssue[]; unregisteredTotal: number } {
  const issues: HealthIssue[] = [];
  const seen = new Set<string>();
  const push = (issue: HealthIssue): void => {
    if (seen.has(issue.key)) return;
    seen.add(issue.key);
    issues.push(issue);
  };
  const owner = ownerOf(input.members);
  const issueCtx: IssueContext = { stats: input.stats, owner };

  // Content first: these are the failures that name a specific note whose only
  // copy is here.
  for (const f of input.failures.content) push(contentIssue(f, issueCtx));
  for (const f of input.failures.registry) push(registryIssue(f, issueCtx));

  // A limit that stopped the run but was recorded against nothing the user can
  // see still has to be said once.
  if (isLimitCode(input.failures.limitCode) && !issues.some((i) => i.kind === "limit")) {
    push({
      ...limitIssue({
        kind: "note",
        path: "",
        docId: null,
        reason: "plan limit",
        code: input.failures.limitCode,
      }),
      key: `limit:${input.failures.limitCode}`,
      path: null,
      why: "The Remote Vault stopped this sync run at a plan limit. Upgrade to continue.",
    });
  }

  if (input.syncEnabled && ctx.signedIn && input.syncStatus === "no-access") {
    push({
      key: "vault:no-access",
      docId: null,
      path: null,
      kind: "no-access",
      severity: "error",
      title: "No access to this vault",
      why:
        "The Remote Vault refused a sync token for this vault, so nothing is uploading " +
        "or downloading. Ask the vault's owner to share it with you again.",
      remedies: ["contact-owner", "copy-details"],
      code: null,
      explanation: {
        meaning:
          "Every note asks the Remote Vault for permission before it syncs, and the " +
          "Remote Vault is turning this vault down. That happens when the vault was set " +
          "to Private, when it was shared read-only and then withdrawn, or when " +
          `you were removed from it. Only ${ownerPhrase(owner)} can change that.`,
        next: "Nothing until access is granted. Baalda keeps asking, and will resume on its own the moment the answer changes.",
        fixes: [
          `Ask ${ownerPhrase(owner)} to share this vault with you again.`,
          "If you expected to be removed, your local files are still here and still yours to keep or export.",
        ],
        // Deliberately `unknown`: refused access means this device cannot ask
        // the server what it holds, so claiming a copy is (or is not) up there
        // would be a guess.
        safety: "unknown",
      },
      facts: [
        { label: "Vault", value: "Access refused by the Remote Vault" },
        ...(owner ? [{ label: "Owner", value: `${owner.name} (${owner.email})`, copyable: true }] : []),
      ],
      autoRetries: true,
    });
  }

  // Notes on disk the registry has never mapped. Only meaningful once the run is
  // NOT in a bulk phase: during registration every unmapped note is simply
  // in-flight, and warning about it would turn a working vault into a wall of
  // alarms for as long as the pass takes.
  //
  // And only once the server has ANSWERED this session. Offline, every unmapped
  // note is unmapped for the same single reason — nobody could register it —
  // so eighteen "Not on the server yet" rows say nothing the verdict's
  // "Offline" does not, and read as eighteen problems. Same rule as the
  // sidebar's dots (`sidebarMarksVisible`).
  let unregisteredTotal = 0;
  const serverAnswered =
    input.syncStatus !== "offline" &&
    input.syncStatus !== "connecting" &&
    input.syncStatus !== "error" &&
    input.syncStatus !== "no-access";
  if (input.syncEnabled && ctx.signedIn && !ctx.bulk && serverAnswered) {
    const failedPaths = new Set<string>([
      ...input.failures.registry.map((f) => f.path),
      ...input.failures.content.map((f) => f.relPath),
    ]);
    for (const path of ctx.mappedPaths.keys()) {
      if (input.docIdByPath[path] !== undefined) continue;
      if (failedPaths.has(path)) continue;
      unregisteredTotal++;
      if (unregisteredTotal > MAX_UNREGISTERED_ISSUES) continue;
      push({
        key: path,
        docId: null,
        path,
        kind: "unregistered",
        severity: "warn",
        title: "Not on the Remote Vault yet",
        why:
          "This note exists only on this device: the Remote Vault has no record for it, " +
          "and nothing has reported a failure. A sync run should pick it up.",
        remedies: ["retry", "open", "reveal"],
        code: null,
        explanation: {
          meaning:
            "The Remote Vault does not know this note yet. That is normal for a note " +
            "created while you were offline, one added to the folder from outside " +
            "Baalda a moment ago, or one whose registration is still queued behind " +
            "others. Nothing has failed — it simply has not had its turn.",
          next: "Registers on the next sync pass, then its content uploads straight after.",
          fixes: [
            "Wait — this usually clears itself within a few seconds of being connected.",
            "Retry now if it has been sitting here.",
            "If it never clears, Copy details from any other note on this page and report it.",
          ],
          safety: "only-here",
        },
        facts: [{ label: "Path", value: path }],
        autoRetries: true,
      });
    }
  }

  const orphanDocs = input.stats?.history.orphanDocs ?? 0;
  if (orphanDocs > 0) {
    const orphanBytes = input.stats?.history.orphanBytes ?? 0;
    push({
      key: "history:orphans",
      docId: null,
      path: null,
      kind: "orphan-history",
      severity: "warn",
      title: "Unused edit history",
      why: `${formatBytes(orphanBytes)} can be freed. Your notes stay unchanged.`,
      remedies: ["reclaim"],
      code: null,
      explanation: {
        meaning: "Old history from notes no longer in this vault. Safe to reclaim or ignore.",
        next: "Kept until you reclaim it.",
        fixes: ["Reclaim to free space."],
        safety: "both",
      },
      facts: [
        { label: "Leftover notes", value: num(orphanDocs) },
        { label: "Space used", value: formatBytes(orphanBytes) },
      ],
      autoRetries: false,
    });
  }

  issues.sort(compareIssues);
  return { issues, unregisteredTotal };
}

/** Errors before warnings; within a severity, by path (vault-level issues, which
 *  have no path, sort first because they explain the rest). Total and stable. */
function compareIssues(a: HealthIssue, b: HealthIssue): number {
  if (a.severity !== b.severity) return a.severity === "error" ? -1 : 1;
  if (a.path === null && b.path !== null) return -1;
  if (a.path !== null && b.path === null) return 1;
  if (a.path !== null && b.path !== null && a.path !== b.path) {
    return a.path < b.path ? -1 : 1;
  }
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

// ── Stages ────────────────────────────────────────────────────────────────────

function buildStages(
  input: HealthInput,
  ctx: {
    verdict: HealthVerdict;
    counts: HealthCounts;
    issues: HealthIssue[];
    bulk: boolean;
    serverHost: string | null;
  },
): HealthStage[] {
  const { verdict, counts, issues, serverHost } = ctx;
  const stats = input.stats;
  const off = !input.syncEnabled;

  // The FIRST stage that explains the verdict carries the error; every later one
  // stays quiet, so the diagram points at one place rather than lighting up.
  const connectionBroken =
    verdict === "signed-out" || verdict === "no-access" || verdict === "offline";
  const hasError = issues.some((i) => i.severity === "error");

  const disk: HealthStage = {
    id: "disk",
    label: "Files on disk",
    state: "ok",
    headline: num(stats ? stats.notes.count : counts.total),
    detail: stats
      ? `${plural(stats.notes.count, "note")}, ${plural(stats.folders, "folder")} and ` +
        `${plural(stats.attachments.count + stats.otherFiles.count, "other file")} in this vault.`
      : `${plural(counts.total, "note")} in this vault.`,
  };

  const index: HealthStage = {
    id: "index",
    label: "Local index",
    state: "ok",
    headline: stats ? num(stats.notes.count) : "Indexed",
    detail: stats
      ? `${plural(stats.tags, "tag")} and ${plural(stats.links, "link")} indexed` +
        (stats.brokenLinks > 0
          ? `, plus ${plural(stats.brokenLinks, "link")} that point at nothing.`
          : ".")
      : "Search and links are built from the local index.",
  };

  const orphanDocs = stats?.history.orphanDocs ?? 0;
  const history: HealthStage = {
    id: "history",
    label: "Local history",
    state: orphanDocs > 0 ? "warn" : "ok",
    headline: stats ? num(stats.history.docs) : "—",
    detail: stats
      ? `${plural(stats.history.docs, "note")} have edit history stored on this device` +
        (orphanDocs > 0
          ? `, of which ${num(orphanDocs)} belong to notes this vault no longer has.`
          : ".")
      : "Edit history is kept locally so offline edits merge instead of clobbering.",
  };

  const connection: HealthStage = {
    id: "connection",
    label: "Connection",
    state: off
      ? "off"
      : connectionBroken
        ? "error"
        : verdict === "connecting"
          ? "busy"
          : input.syncStatus === "read-only"
            ? "warn"
            : "ok",
    headline: off
      ? "Off"
      : verdict === "signed-out"
        ? "Signed out"
        : verdict === "no-access"
          ? "No access"
          : verdict === "offline"
            ? "Offline"
            : verdict === "connecting"
              ? "Reconnecting…"
              : input.syncStatus === "read-only"
                ? "View only"
                : "Connected",
    detail: off
      ? "This vault is not connected to a Remote Vault."
      : verdict === "signed-out"
        ? "Sign in to start syncing again. Edits stay on this device until you do."
        : verdict === "no-access"
          ? "The Remote Vault refused a sync token for this vault."
          : verdict === "offline"
            ? `Not reachable right now${serverHost ? ` · ${serverHost}` : ""}.`
            : verdict === "connecting"
              ? "Establishing the connection."
              : input.syncStatus === "read-only"
                ? "You have view-only access, so your edits stay on this device."
                : `Connected${serverHost ? ` to ${serverHost}` : ""}.`,
  };

  const serverState: HealthStageState = off
    ? "off"
    : connectionBroken
      ? "ok" // the connection stage already owns this failure
      : ctx.bulk
        ? "busy"
        : hasError || counts.failed > 0
          ? "error"
          : counts.unreported > 0 || counts.unsynced > 0
            ? "warn"
            : "ok";

  const server: HealthStage = {
    id: "server",
    label: "Remote Vault",
    state: serverState,
    headline: off ? "—" : num(counts.synced),
    detail: off
      ? "Turn on sync to keep a copy on the Remote Vault."
      : `${num(counts.synced)} of ${plural(counts.total, "note")} confirmed on the Remote Vault` +
        (serverHost ? ` · ${serverHost}` : "") +
        ".",
  };

  return [disk, index, history, connection, server];
}

// ── Headline / detail ─────────────────────────────────────────────────────────

function describe(
  input: HealthInput,
  ctx: {
    verdict: HealthVerdict;
    counts: HealthCounts;
    errors: number;
    serverHost: string | null;
    unregisteredTotal: number;
  },
): { headline: string; detail: string } {
  const { verdict, counts, errors, serverHost } = ctx;
  const behind = Math.max(0, counts.total - counts.synced);
  const where = serverHost ? ` · ${serverHost}` : "";
  const last =
    input.lastSyncedAt != null
      ? `Last confirmed ${relativeTime(input.lastSyncedAt, input.now)}`
      : "Nothing confirmed yet this session";
  const overflow =
    ctx.unregisteredTotal > MAX_UNREGISTERED_ISSUES
      ? ` Showing the first ${num(MAX_UNREGISTERED_ISSUES)} of ${num(ctx.unregisteredTotal)} unregistered notes.`
      : "";

  switch (verdict) {
    case "local":
      return {
        headline: "Sync is off for this folder",
        detail:
          `${plural(counts.total, "note")} live here on this device only. ` +
          `Turn on sync to reach your other devices and your team.`,
      };
    case "signed-out":
      return {
        headline: "Signed out — nothing is syncing",
        detail:
          `This vault syncs with${serverHost ? ` ${serverHost}` : " its Remote Vault"}. ` +
          `Sign in to resume. Your edits are safe on disk in the meantime.`,
      };
    case "no-access":
      return {
        headline: "You no longer have access to this vault",
        detail:
          `The Remote Vault refused a sync token, so nothing is moving in either ` +
          `direction. Ask the vault's owner to share it with you again.${where}`,
      };
    case "offline":
      return {
        headline: `Offline — ${num(counts.synced)} of ${plural(counts.total, "note")} are on the Remote Vault`,
        detail: `${last}. Syncing resumes on its own when the connection comes back.${where}`,
      };
    case "connecting":
      return {
        headline: "Connecting…",
        detail: `${last}${where}.`,
      };
    case "syncing": {
      const p = input.syncProgress;
      if (p?.phase === "removing") return {
        headline: `Updating access — ${num(Math.max(0, p.total - p.done))} remaining`,
        detail: "Removing local copies you can no longer access.",
      };
      const of = p && p.total > 0 ? `${num(p.done)} of ${num(p.total)}` : num(behind);
      return {
        headline: `Syncing — ${of} updates`,
        detail:
          `${num(counts.synced)} of ${plural(counts.total, "note")} are confirmed so far` +
          `${where}.${overflow}`,
      };
    }
    case "attention":
      return {
        headline:
          behind === 0
            ? `${plural(errors, "thing")} need${errors === 1 ? "s" : ""} you`
            : errors > 0
              ? `${plural(behind, "note")} not on the Remote Vault — ${num(errors)} need you`
              : `${plural(behind, "note")} ${behind === 1 ? "is" : "are"} not on the Remote Vault`,
        detail: `${last}${where}.${overflow}`,
      };
    case "healthy":
    default:
      return {
        headline:
          counts.total === 0
            ? "This vault is empty"
            : `All ${plural(counts.total, "note")} are on the Remote Vault`,
        detail: `${last}${where}.${overflow}`,
      };
  }
}

/**
 * "Where your content is", in words. One sentence per `safety` value, shared by
 * the page and by the text `copyIssue` puts on the clipboard so a bug report and
 * the screen cannot claim different things about the same note.
 */
export function safetyLabel(safety: HealthExplanation["safety"]): string {
  switch (safety) {
    case "only-here":
      return "On this device only — the Remote Vault has no confirmed copy of it.";
    case "on-server":
      return "On the Remote Vault. What failed was writing it onto this device.";
    case "both":
      return "On this device and on the Remote Vault.";
    case "unknown":
      return "Not known — Baalda cannot confirm right now where a copy exists.";
  }
}

// ── Per-note inspector ────────────────────────────────────────────────────────

/** Exactly the facts `useVaultHealth.inspectNote` has gathered, in the order the
 *  verdict considers them. Kept pure so the one sentence a user reads about
 *  their own note is unit-tested rather than assembled inside a hook. */
export interface InspectVerdictInput {
  /** Is there a file at this path right now? */
  exists: boolean;
  syncEnabled: boolean;
  /** The Needs-attention row for this note, when it has one. */
  issue: HealthIssue | null;
  permanentFailure: string | null;
  queued: boolean;
  diverged: boolean;
  state: DocSyncState | null;
  /** The registry's durable "the server has this content" checkpoint. */
  pushed: boolean;
  docId: string | null;
}

/**
 * ONE honest sentence about where this note stands.
 *
 * The order is the point. Each check below can be true at the same time as the
 * ones under it, and the first true one is the one that changes what the reader
 * should do — so a note with an issue says so even though it is also "not
 * confirmed", and a note with no file at all never claims a sync state for a
 * file that isn't there. Nothing here says "safe on the server" unless `pushed`
 * or a `synced` report actually said so.
 */
export function composeInspectionVerdict(i: InspectVerdictInput): string {
  if (!i.exists) return "There is no file at this path.";
  if (!i.syncEnabled) return "This folder does not sync, so this note lives on this device only.";
  if (i.issue) return `${i.issue.title} — see Needs attention above for what to do.`;
  if (i.permanentFailure) {
    return `Baalda stopped trying to sync this note: ${capitalize(i.permanentFailure)}`;
  }
  if (i.queued) return "Waiting to be pushed — it is in the queue for the next sync pass.";
  if (i.diverged) return "Has edits the Remote Vault may not have yet; the next sync pass will send them.";
  if (i.state === "synced" && i.pushed) {
    return "Synced — the Remote Vault confirmed this note's content.";
  }
  if (i.pushed && i.state === null) {
    return "On the Remote Vault; nothing about it has changed since this app launched.";
  }
  if (i.docId === null) return "The Remote Vault does not know this note yet.";
  return "Not confirmed yet — nothing has reported this note's content as stored on the Remote Vault.";
}
