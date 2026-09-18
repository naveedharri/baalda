// The Health page's CHECK-LEVEL actions: one button that treats the whole
// finding instead of twenty-five buttons that treat one row each.
//
// Two kinds, and the difference is the point:
//
//   • a HEAL is Baalda fixing the finding itself — rebuild the index, reclaim
//     orphan history, create the notes a link points at. Mechanical, defined
//     for every item, and safe to run without reading the list first.
//   • a BULK action is the per-item button applied to everything listed —
//     "Delete all", "Save copies". It is the reader's decision, taken once.
//
// A check gets a heal only where the fix cannot be wrong (`checks.ts` says
// which, and says in `howToFix` why the others are left manual). Renaming
// across a judgement call, rewriting YAML we could not parse, or guessing which
// of two colliding names is the intruder are all refusals, deliberately.
//
// Everything here is PURE except `runCheckAction`, whose entire I/O surface is
// the injected `CheckActionDeps` — so the planning, the wording, the skip rules
// and the execution loop are all unit-tested in Node with no Tauri host, like
// the bridge suites.

import { isNoteExt } from "../formats";
import {
  CHECK_ACTIONS,
  WHOLE_VAULT_ACTIONS,
  type CheckAction,
  type CheckDefinition,
  type CheckRow,
} from "./checks";
import { formatBytes } from "./format";
import type { VaultCheckId, VaultCheckItem, VaultCheckResult } from "./types";

/** One thing an action will act on. */
export interface CheckActionTarget {
  path: string;
  docId: string | null;
}

/** A listed item the action will NOT touch, and the reason in one line. */
export interface CheckActionSkip {
  path: string;
  reason: string;
}

/**
 * Everything the page needs to offer, confirm and run one action — decided
 * before anything happens, so the confirmation can state the true number and
 * the row can say what it is going to leave alone.
 */
export interface CheckActionPlan {
  checkId: VaultCheckId;
  action: CheckAction;
  kind: "heal" | "bulk";
  label: string;
  /** "Deleted" / "Created" — the result line's verb. */
  verb: string;
  /** "Deleting" / "Creating" — the progress line's verb. */
  gerund: string;
  /** Acts on the vault as a whole; `targets` is empty and means nothing. */
  wholeVault: boolean;
  targets: CheckActionTarget[];
  skipped: CheckActionSkip[];
  /** Items the check counted but did not list — out of this action's reach. */
  unlisted: number;
  confirm: {
    title: string;
    body: string;
    confirmLabel: string;
    tone: "danger" | "accent";
  } | null;
}

/** What one run did. Reported inline on the row, never only in a toast. */
export interface CheckActionOutcome {
  action: CheckAction;
  /** Succeeded. */
  done: number;
  /** Attempted. */
  total: number;
  /** One extra fact worth saying: bytes freed, files found. */
  note: string | null;
  errors: CheckActionSkip[];
  skipped: CheckActionSkip[];
  /** The reader backed out of a picker; nothing happened. */
  cancelled: boolean;
}

// ── Planning ──────────────────────────────────────────────────────────────────

/** Every action a FAILING check offers, heal first. */
export function checkActionPlans(row: CheckRow): CheckActionPlan[] {
  if (row.passed) return [];
  const out: CheckActionPlan[] = [];
  if (row.def.heal) {
    const plan = planCheckAction(row.def, row.result, row.def.heal, "heal");
    if (plan) out.push(plan);
  }
  for (const action of row.def.bulkActions ?? []) {
    const plan = planCheckAction(row.def, row.result, action, "bulk");
    if (plan) out.push(plan);
  }
  return out;
}

/**
 * Plan ONE action. Null when there is nothing left for it to do — every listed
 * item was skipped — so a row never offers a button that would report "0 of 0".
 */
export function planCheckAction(
  def: CheckDefinition,
  result: VaultCheckResult,
  action: CheckAction,
  kind: "heal" | "bulk",
): CheckActionPlan | null {
  const wording = CHECK_ACTIONS[action];
  const wholeVault = WHOLE_VAULT_ACTIONS.has(action);
  const targets: CheckActionTarget[] = [];
  const skipped: CheckActionSkip[] = [];

  if (!wholeVault) {
    for (const item of result.items) {
      const verdict = judge(action, item);
      if (verdict === null) targets.push({ path: item.path, docId: item.docId ?? null });
      else skipped.push({ path: item.path, reason: verdict });
    }
    if (targets.length === 0) return null;
  }

  const n = wholeVault ? result.count : targets.length;
  const confirm = wording.confirm
    ? {
        ...wording.confirm,
        title: fill(wording.confirm.title, n, def),
        body: fill(wording.confirm.body, n, def),
      }
    : null;

  return {
    checkId: def.id,
    action,
    kind,
    label: wording.label,
    verb: wording.verb,
    gerund: wording.gerund,
    wholeVault,
    targets,
    skipped,
    unlisted: wholeVault ? 0 : Math.max(0, result.count - result.items.length),
    confirm,
  };
}

/** Why this item is out of this action's reach, or null when it is in it. */
function judge(action: CheckAction, item: VaultCheckItem): string | null {
  switch (action) {
    case "reset-history-all":
      return item.docId
        ? null
        : "no edit history is recorded for this file, so there is nothing to reset";
    case "rename-legal": {
      const to = suggestLegalPath(item.path);
      if (to === null) {
        return "the offending name is a folder, or nothing legal is left of it — rename it yourself";
      }
      return null;
    }
    default:
      return null;
  }
}

/** `{n}` → the count, `{check}` → the check's label, lower-cased mid-sentence. */
function fill(text: string, n: number, def: CheckDefinition): string {
  return text
    .replace(/\{n\}/g, n.toLocaleString())
    .replace(/\{check\}/g, def.label.toLowerCase());
}

// ── Legal names ───────────────────────────────────────────────────────────────

/** Stems Windows refuses whatever the extension — `checks.rs RESERVED_STEMS`. */
const RESERVED_STEMS = new Set([
  "CON", "PRN", "AUX", "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/** Characters Windows refuses — `checks.rs ILLEGAL_CHARS`, same set. */
const ILLEGAL_CHARS = /[<>:"|?*]/g;

/**
 * One path segment, made legal on Windows: the offending character becomes `-`,
 * a trailing dot or space is dropped, and a reserved stem gets a leading `_`.
 *
 * The rules mirror `checks.rs illegal_reason` exactly — that function decides
 * what is reported, this one decides what it becomes, and a drift between them
 * would produce a heal that leaves the row still failing.
 */
export function legalSegment(seg: string): string {
  let out = seg.replace(ILLEGAL_CHARS, "-");
  out = Array.from(out)
    .map((c) => {
      const code = c.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f ? "-" : c;
    })
    .join("");
  out = out.replace(/[. ]+$/, "");
  const stem = (out.split(".")[0] ?? "").toUpperCase();
  if (RESERVED_STEMS.has(stem)) out = `_${out}`;
  return out;
}

/**
 * The legal path this one should become, or null when the heal must not touch
 * it: the offending segment is a PARENT (renaming a folder moves everything
 * inside it, which is not a heal), nothing is left of the name, or it is
 * already legal.
 */
export function suggestLegalPath(path: string): string | null {
  const segs = path.split("/");
  const last = segs.length - 1;
  if (last < 0 || segs[last] === "") return null;
  for (let i = 0; i < last; i++) {
    if (legalSegment(segs[i]!) !== segs[i]) return null;
  }
  const fixed = legalSegment(segs[last]!);
  if (fixed === "" || fixed === segs[last]) return null;
  segs[last] = fixed;
  return segs.join("/");
}

// ── Wikilinks ─────────────────────────────────────────────────────────────────

/** `[[target]]`, `[[target|alias]]`, `[[target#heading]]` — `parse.rs WIKILINK_RE`. */
const WIKILINK_RE = /\[\[([^\]\n]+)\]\]/g;

/**
 * Every wikilink target in a note, alias and heading stripped, in order and
 * de-duplicated. The same extraction `parse.rs` indexes with, so the targets
 * this heal creates are exactly the ones the check counted.
 */
export function wikilinkTargets(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(WIKILINK_RE)) {
    const target = (m[1] ?? "")
      .split("|")[0]!
      .split("#")[0]!
      .trim();
    if (target === "" || seen.has(target)) continue;
    seen.add(target);
    out.push(target);
  }
  return out;
}

/**
 * Can this link target become an empty note?
 *
 * No for anything that escapes the vault, and no for a target that names a FILE
 * of another kind (`![[diagram.png]]` is indexed as a link too, and a missing
 * image is the `missing-embeds` check's finding, not a note waiting to be
 * created). A target with no extension at all is a note name — the common case.
 */
export function isCreatableTarget(target: string): boolean {
  if (target === "" || target.startsWith("/") || target.startsWith("\\")) return false;
  if (target.includes("..")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return false; // http:, mailto:, obsidian:
  const name = target.split("/").pop() ?? "";
  if (name === "" || name === "." ) return false;
  // An extension we do not treat as a note means this is a file link.
  if (/\.[A-Za-z0-9]+$/.test(name) && !isNoteExt(name)) return false;
  return true;
}

/** Split a link target into the folder it names and the note name in it. */
export function targetLocation(target: string): { dir: string; name: string } {
  const slash = target.lastIndexOf("/");
  return slash === -1
    ? { dir: "", name: target }
    : { dir: target.slice(0, slash), name: target.slice(slash + 1) };
}

// ── Export destinations ───────────────────────────────────────────────────────

/** The last path segment — what a copy outside the vault should be called. */
export function basename(path: string): string {
  const seg = path.split("/").pop();
  return seg != null && seg !== "" ? seg : path;
}

/**
 * A name no earlier copy in this run has taken. Two notes called `index.md` in
 * different folders export into ONE folder, and the second must not overwrite
 * the first.
 */
export function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem} ${i}${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  const fallback = `${stem} ${Date.now()}${ext}`;
  used.add(fallback);
  return fallback;
}

// ── Execution ─────────────────────────────────────────────────────────────────

/**
 * Every side effect a heal or bulk action can have, injected.
 *
 * All of them are EXISTING code paths — the sidebar's delete, the sync layer's
 * history reset, the startup CRDT sweep, `ipc.createNote`, the store's rename
 * (which is what keeps `doc_id` stable across a move). Nothing here invents a
 * new way to touch the vault.
 */
export interface CheckActionDeps {
  /** The sidebar's delete, for many paths: server row first, then disk. */
  deleteNotes(
    paths: string[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ deleted: string[]; failed: CheckActionSkip[] }>;
  resetHistory(docId: string): Promise<{ bytesFreed: number }>;
  reclaim(): Promise<{ docsRemoved: number; bytesReclaimed: number }>;
  emptyTrash(): Promise<{ filesRemoved: number; bytesFreed: number }>;
  rebuildIndex(): Promise<void>;
  syncNow(): Promise<void>;
  /** Native folder picker; null when the reader cancels. */
  pickFolder(): Promise<string | null>;
  /** Copy one vault-relative path to an absolute destination. */
  exportTo(path: string, dest: string): Promise<void>;
  readNote(path: string): Promise<string>;
  /** True when this wikilink target resolves to a note in the vault. */
  resolveLink(target: string): Promise<boolean>;
  /** Create an empty note; resolves to its vault-relative path. */
  createNote(dir: string, name: string): Promise<string>;
  /** True when a FILE (not a folder) exists at this path. */
  isFile(path: string): Promise<boolean>;
  /** Rename through the path that preserves `doc_id`. */
  rename(from: string, to: string): Promise<void>;
}

const EMPTY = (action: CheckAction): CheckActionOutcome => ({
  action,
  done: 0,
  total: 0,
  note: null,
  errors: [],
  skipped: [],
  cancelled: false,
});

/** Run a planned action. Never throws: a failure is one line of the outcome. */
export async function runCheckAction(
  plan: CheckActionPlan,
  deps: CheckActionDeps,
  onProgress?: (done: number, total: number) => void,
): Promise<CheckActionOutcome> {
  const out = EMPTY(plan.action);
  out.skipped = [...plan.skipped];
  const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

  switch (plan.action) {
    // ── whole vault ────────────────────────────────────────────────────────
    case "rebuild-index":
    case "sync-now": {
      out.total = 1;
      try {
        if (plan.action === "rebuild-index") await deps.rebuildIndex();
        else await deps.syncNow();
        out.done = 1;
      } catch (e) {
        out.errors.push({ path: "", reason: reason(e) });
      }
      return out;
    }
    case "reclaim": {
      try {
        const { docsRemoved, bytesReclaimed } = await deps.reclaim();
        out.done = docsRemoved;
        out.total = docsRemoved;
        out.note =
          docsRemoved === 0 ? "Nothing to reclaim" : `${formatBytes(bytesReclaimed)} freed`;
      } catch (e) {
        out.errors.push({ path: "", reason: reason(e) });
      }
      return out;
    }
    case "empty-trash": {
      try {
        const { filesRemoved, bytesFreed } = await deps.emptyTrash();
        out.done = filesRemoved;
        out.total = filesRemoved;
        out.note = filesRemoved === 0 ? "Nothing to empty" : `${formatBytes(bytesFreed)} freed`;
      } catch (e) {
        out.errors.push({ path: "", reason: reason(e) });
      }
      return out;
    }

    // ── the listed items ───────────────────────────────────────────────────
    case "delete-all": {
      const paths = plan.targets.map((t) => t.path);
      out.total = paths.length;
      try {
        const { deleted, failed } = await deps.deleteNotes(paths, onProgress);
        out.done = deleted.length;
        out.errors = failed;
      } catch (e) {
        out.errors.push({ path: "", reason: reason(e) });
      }
      return out;
    }

    case "export-all": {
      const dir = await deps.pickFolder().catch(() => null);
      if (dir == null) {
        out.cancelled = true;
        return out;
      }
      out.total = plan.targets.length;
      const used = new Set<string>();
      let done = 0;
      for (const target of plan.targets) {
        const dest = `${dir.replace(/\/+$/, "")}/${uniqueName(basename(target.path), used)}`;
        try {
          await deps.exportTo(target.path, dest);
          out.done++;
        } catch (e) {
          out.errors.push({ path: target.path, reason: reason(e) });
        }
        onProgress?.(++done, plan.targets.length);
      }
      out.note = out.done > 0 ? `in ${dir}` : null;
      return out;
    }

    case "reset-history-all": {
      out.total = plan.targets.length;
      let freed = 0;
      let done = 0;
      for (const target of plan.targets) {
        if (!target.docId) {
          out.skipped.push({ path: target.path, reason: "no doc id" });
          onProgress?.(++done, plan.targets.length);
          continue;
        }
        try {
          const { bytesFreed } = await deps.resetHistory(target.docId);
          freed += bytesFreed;
          out.done++;
        } catch (e) {
          out.errors.push({ path: target.path, reason: reason(e) });
        }
        onProgress?.(++done, plan.targets.length);
      }
      out.note = freed > 0 ? `${formatBytes(freed)} freed` : null;
      return out;
    }

    case "create-missing-notes": {
      // Scanned per SOURCE note, because that is what the check lists; the
      // targets are pooled so a name three notes link to is created once.
      const created = new Set<string>();
      let scanned = 0;
      let missing = 0;
      for (const source of plan.targets) {
        let text = "";
        try {
          text = await deps.readNote(source.path);
        } catch (e) {
          out.errors.push({ path: source.path, reason: reason(e) });
          onProgress?.(++scanned, plan.targets.length);
          continue;
        }
        for (const target of wikilinkTargets(text)) {
          if (created.has(target)) continue;
          if (!isCreatableTarget(target)) {
            out.skipped.push({
              path: target,
              reason: "not a note name — a file link, or it leaves the vault",
            });
            created.add(target);
            continue;
          }
          let resolves = true;
          try {
            resolves = await deps.resolveLink(target);
          } catch (e) {
            out.errors.push({ path: target, reason: reason(e) });
            created.add(target);
            continue;
          }
          if (resolves) continue;
          missing++;
          created.add(target);
          const { dir, name } = targetLocation(target);
          try {
            await deps.createNote(dir, name);
            out.done++;
          } catch (e) {
            out.errors.push({ path: target, reason: reason(e) });
          }
        }
        onProgress?.(++scanned, plan.targets.length);
      }
      out.total = missing;
      out.note =
        missing === 0 ? "Every link resolved — nothing was missing" : null;
      return out;
    }

    case "rename-legal": {
      out.total = plan.targets.length;
      let done = 0;
      for (const target of plan.targets) {
        const to = suggestLegalPath(target.path);
        if (to == null) {
          out.skipped.push({ path: target.path, reason: "nothing legal to rename it to" });
          onProgress?.(++done, plan.targets.length);
          continue;
        }
        try {
          // A folder is never renamed by a heal (it would move everything
          // inside it), and `isFile` is the only honest test we have — the
          // check reports files and folders in one list.
          if (!(await deps.isFile(target.path))) {
            out.skipped.push({
              path: target.path,
              reason: "this is a folder — rename it in the sidebar",
            });
          } else if (await deps.isFile(to)) {
            out.skipped.push({
              path: target.path,
              reason: `\`${basename(to)}\` is taken — rename it yourself`,
            });
          } else {
            await deps.rename(target.path, to);
            out.done++;
          }
        } catch (e) {
          out.errors.push({ path: target.path, reason: reason(e) });
        }
        onProgress?.(++done, plan.targets.length);
      }
      return out;
    }

    // Per-item actions are never planned as a whole-check run.
    default:
      return out;
  }
}

/**
 * The one line a finished run puts on the row.
 *
 * Honest about all three shapes: "Deleted 12 of 12" for an action over the
 * listed items, the action's own fact for one that treats the vault ("3.4 MB
 * freed"), and a failure that says so rather than reporting a silent zero.
 */
export function outcomeSummary(
  outcome: CheckActionOutcome,
  plan: CheckActionPlan,
): string {
  if (outcome.cancelled) return "Cancelled — nothing changed";
  const failed = outcome.errors.length;
  const parts: string[] = [];
  let note = outcome.note;

  if (plan.wholeVault) {
    if (outcome.done === 0 && failed > 0) return `${plan.label} failed`;
    if (plan.action === "rebuild-index" || plan.action === "sync-now") {
      parts.push(plan.verb);
    } else if (outcome.done === 0 && note) {
      return note;
    } else {
      parts.push(`${plan.verb} ${outcome.done.toLocaleString()}`);
    }
  } else if (outcome.total === 0 && note) {
    // Nothing turned out to need doing, and the action can say so in its own
    // words — "Created 0 of 0" is true and useless.
    parts.push(note);
    note = null;
  } else {
    parts.push(
      `${plan.verb} ${outcome.done.toLocaleString()} of ${outcome.total.toLocaleString()}`,
    );
  }

  if (note) parts.push(note);
  if (failed > 0) parts.push(`${failed.toLocaleString()} failed`);
  if (outcome.skipped.length > 0) {
    parts.push(`${outcome.skipped.length.toLocaleString()} left alone`);
  }
  return parts.join(" · ");
}
