// One note, one id: the heal for notes whose local index id is not the id the
// registry (and the server) know them by.
//
// Older builds could index a note under a fresh local id while the registry
// mapped its path to the server's id: a background bridge writing a teammate's
// note before it was on disk (fixed in `write_note`), or a case twin left by a
// folder spelled in another case (fixed in the index). The editor keys its
// bridge by the INDEX id and sync by the registry's, so such a note kept two
// local CRDT logs and, for a delete, could look like a new note.
//
// The heal re-keys the index row to the registry's id. History kept under the
// fresh id is folded into the real id's log first, but only when that is
// provably safe: two logs grown from the same server state merge into the same
// text; two independent seeds of one file would double it, and those are left
// exactly as they are (and said once).

import * as Y from "yjs";
import type { YjsState } from "../ipcCodec";

export interface ForkHealDeps {
  titles(): Promise<Array<{ id: string; path: string }>>;
  /** The registry's id for a disk path (case-tolerant), or null. */
  registeredId(path: string): string | null;
  /** True while a bridge for this id is open or resident: healed next pass. */
  busy(docId: string): boolean;
  load(docId: string): Promise<YjsState>;
  /** The state vector the server is known to cover for the real id, or null. */
  acked(docId: string): Uint8Array | null;
  append(docId: string, update: Uint8Array): Promise<unknown>;
  heal(path: string, docId: string): Promise<boolean>;
  clear(docId: string): Promise<unknown>;
  /** The real id's local state vector after a fold (the hello manifest). */
  stateVector?(docId: string, sv: Uint8Array): void;
  log?(line: string): void;
}

function docOf(state: YjsState | null): Y.Doc | null {
  if (!state || (!state.snapshot && state.updates.length === 0)) return null;
  const doc = new Y.Doc();
  if (state.snapshot) Y.applyUpdate(doc, state.snapshot);
  for (const u of state.updates) Y.applyUpdate(doc, u);
  return doc;
}

function covers(a: Y.Doc, b: Y.Doc): boolean {
  const sa = Y.decodeStateVector(Y.encodeStateVector(a));
  for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(b))) {
    if ((sa.get(client) ?? 0) < clock) return false;
  }
  return true;
}

/**
 * What to do with the fresh id's history before the row is re-keyed:
 * `none` (nothing to keep), `fold` (append this update to the real id) or
 * `refuse` (the two would not merge into either one's text: leave the split).
 */
export function planFold(real: YjsState | null, fresh: YjsState | null, acked: Uint8Array | null = null):
  | { kind: "none" }
  | { kind: "fold"; update: Uint8Array }
  | { kind: "refuse" } {
  const b = docOf(fresh);
  if (!b) return { kind: "none" };
  const a = docOf(real);
  try {
    if (!a) {
      // Nothing local under the real id: the fresh log is kept only when it
      // grew from what the server holds (it shares a writer with the server's
      // acknowledged state). An unprovable lineage could be a second seed of
      // the file, and folding it would double the note on the next sync.
      if (b.getText("content").length === 0) return { kind: "fold", update: Y.encodeStateAsUpdate(b) };
      if (!acked) return { kind: "refuse" };
      const server = Y.decodeStateVector(acked);
      const shared = [...Y.decodeStateVector(Y.encodeStateVector(b)).keys()].some((c) => server.has(c));
      return shared ? { kind: "fold", update: Y.encodeStateAsUpdate(b) } : { kind: "refuse" };
    }
    if (covers(a, b)) return { kind: "none" };
    if (covers(b, a)) return { kind: "fold", update: Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)) };
    // Each holds ops the other lacks. Safe only when they share history (one
    // lineage, edits on both sides): the merged text then extends both. Two
    // seeds of the same file share nothing and would double it.
    const ta = a.getText("content").toString();
    const tb = b.getText("content").toString();
    const sa = Y.decodeStateVector(Y.encodeStateVector(a));
    const shared = [...Y.decodeStateVector(Y.encodeStateVector(b)).keys()].some((c) => sa.has(c));
    if (!shared && ta.length > 0 && tb.length > 0) return { kind: "refuse" };
    return { kind: "fold", update: Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)) };
  } finally {
    a?.destroy();
    b.destroy();
  }
}

/** Heal every forked row the index holds. Never throws. `folded` names the real
 *  ids that gained history the server may not have: the caller pushes them. */
export async function healForkedIds(deps: ForkHealDeps): Promise<{ healed: number; folded: string[] }> {
  let healed = 0;
  const folded: string[] = [];
  let titles: Array<{ id: string; path: string }>;
  try {
    titles = await deps.titles();
  } catch {
    return { healed, folded };
  }
  for (const t of titles) {
    const real = deps.registeredId(t.path);
    if (!real || real === t.id) continue;
    if (deps.busy(t.id) || deps.busy(real)) continue;
    try {
      const plan = planFold(await deps.load(real), await deps.load(t.id), deps.acked(real));
      if (plan.kind === "refuse") {
        deps.log?.(`[sync] ${t.path}: two separate histories under ${t.id} and ${real}; left as they are`);
        continue;
      }
      if (plan.kind === "fold") {
        await deps.append(real, plan.update);
        const merged = new Y.Doc();
        const realState = await deps.load(real);
        if (realState.snapshot) Y.applyUpdate(merged, realState.snapshot);
        for (const u of realState.updates) Y.applyUpdate(merged, u);
        deps.stateVector?.(real, Y.encodeStateVector(merged));
        merged.destroy();
      }
      if (await deps.heal(t.path, real)) {
        healed++;
        if (plan.kind === "fold") folded.push(real);
        await deps.clear(t.id);
        deps.log?.(`[sync] ${t.path}: one id again (${real}, was ${t.id}${plan.kind === "fold" ? ", its local history kept" : ""})`);
      }
    } catch (e) {
      if (e instanceof Error && /vault/i.test(e.message) && /epoch|changed|mismatch/i.test(e.message)) break;
    }
  }
  return { healed, folded };
}
