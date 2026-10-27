// One-click Publish writes its own release note from what changed since the
// previous version ("Updated SKILL.md, scripts/run.py"). Pure, pinned by
// `__tests__/publishNotes.test.ts`.

import { SKILL_MAX_NOTES_CHARS } from "./validate";

interface FileSha {
  path: string;
  sha256: string;
  executable?: boolean;
}

function describe(verb: string, paths: string[]): string | null {
  if (paths.length === 0) return null;
  if (paths.length <= 2) return `${verb} ${paths.join(", ")}`;
  return `${verb} ${paths.length} files`;
}

/** "First version", or what was added, updated and removed relative to `previous`. */
export function publishNotes(draft: readonly FileSha[], previous: readonly FileSha[] | null): string {
  if (!previous) return "First version";
  const before = new Map(previous.map((f) => [f.path, f]));
  const now = new Set(draft.map((f) => f.path));
  const added: string[] = [];
  const updated: string[] = [];
  for (const f of draft) {
    const old = before.get(f.path);
    if (!old) added.push(f.path);
    else if (old.sha256 !== f.sha256 || !!old.executable !== !!f.executable) updated.push(f.path);
  }
  const removed = previous.filter((f) => !now.has(f.path)).map((f) => f.path);
  const byName = (a: string, b: string) => (a === "SKILL.md" ? -1 : b === "SKILL.md" ? 1 : a.localeCompare(b));
  const parts = [
    describe("Updated", updated.sort(byName)),
    describe("Added", added.sort(byName)),
    describe("Removed", removed.sort(byName)),
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) return "No file changes";
  const text = parts.map((p, i) => (i === 0 ? p : p.charAt(0).toLowerCase() + p.slice(1))).join(", ");
  return text.length > SKILL_MAX_NOTES_CHARS ? `${text.slice(0, SKILL_MAX_NOTES_CHARS - 1)}…` : text;
}
