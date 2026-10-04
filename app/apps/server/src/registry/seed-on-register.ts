import { createHash } from "node:crypto";
import * as Y from "yjs";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { createResolverCache } from "../permissions/resolver.js";
import { syncPermission } from "../trash/access.js";
import { applyDocPushBatch, serverStateCovers, type DocApplyItem } from "../sync/doc-batch.js";
import { inc } from "../metrics/sync-metrics.js";

/**
 * One-step note creation: the registration request carries the note's binary
 * Yjs state, and the server writes it right after the row (plan
 * `one-step-note-sync.md` §5.2).
 *
 * Deliberately NOT a new write path. The row goes in through `registerNotes` /
 * `registerNote` exactly as before (quota, `canCreateIn`, `root_frozen`,
 * `path_folder_mismatch`, adopt-by-path and the 23505 fallback all decide BEFORE
 * any row or state exists), the register connection is released, and only then
 * does the state go through `applyDocPushBatch` with `expectEmpty` — so the live
 * Hocuspocus branch, the shrink guard, the seed origin that skips version
 * capture (`BULK_SEED_ORIGIN`), fan-out and indexing all apply unchanged.
 * A CTE that inserted the row and the update in one statement would have
 * bypassed every one of those (§4.1 point 1).
 *
 * Who gets state:
 *  · a row THIS call created;
 *  · a row that already carried the SAME id in this vault (an old client or an
 *    interrupted run registered it and never pushed), after the covered check.
 * Never: an adopt onto a DIFFERENT winner id, a `conflict`, or any refusal.
 *
 * Old-server fallback for the desktop: a server without this module ignores
 * `state` and answers WITHOUT `seeded`. A client must treat a missing `seeded`
 * on an item it sent state for as "not seeded" and push through `docs/batch`.
 * `GET /health` `features` (`notes-with-state`) lets it skip that wasted chunk.
 */

/** Advertised on `GET /health` `features` when this server takes `state`. */
export const NOTES_WITH_STATE_FEATURE = "notes-with-state";

/** Additive per-item response fields. Present only when the item sent `state`. */
export interface SeedFields {
  /** True when the server now holds every op in the submitted state. */
  seeded: boolean;
  /**
   * `applied`  — this call wrote the state.
   * `covered`  — the server already held every op (a retry after a lost
   *              response, or an identical re-send). Success: treat as seeded.
   * `conflict` — the row already held other text; nothing written. The client
   *              pull-merges, exactly as after a docs/batch `expectEmpty` conflict.
   * `skipped`  — the item was adopted onto a DIFFERENT id; nothing written.
   * `refused`  — refused before or during the apply (`reason` says why).
   */
  content: "applied" | "covered" | "conflict" | "skipped" | "refused";
  /** Why it was not seeded, or `covered`. Absent on a plain `applied`. */
  reason?: string;
  /**
   * base64 Yjs state vector the server is now PROVEN to cover: the submitted
   * state's own vector (the server may hold more). Safe input for the desktop's
   * `recordAck`. Present only when `seeded`.
   */
  sv?: string;
}

export interface ParsedState {
  bytes: Uint8Array;
  /** Submitted state vector, also the validity probe for `bytes`. */
  sv: Uint8Array;
}

export type StateParse =
  | { ok: true; state: ParsedState | null }
  | { ok: false; code: "invalid_state" | "note_too_large"; message: string };

/** Per-note ceiling, the same bytes the CRDT store and docs/batch enforce. */
export function perNoteStateCap(): number {
  return config.maxNoteMb * 1024 * 1024;
}

/**
 * Decode and validate an item's optional `state` (+ optional `textSha256`).
 * Runs BEFORE registration, so a malformed or oversized state never gets a row.
 * The sha is a mismatch alarm only: a mismatch is logged and never refused,
 * because the CRDT, not the text hash, is what the server stores.
 */
export function parseState(raw: unknown, textSha256: unknown, docId?: string): StateParse {
  if (raw === undefined || raw === null) return { ok: true, state: null };
  if (typeof raw !== "string") {
    inc("seed.invalid");
    return { ok: false, code: "invalid_state", message: "state must be a base64 string" };
  }
  const bytes = new Uint8Array(Buffer.from(raw, "base64"));
  if (bytes.length > perNoteStateCap()) {
    inc("seed.invalid");
    return { ok: false, code: "note_too_large", message: "state exceeds the per-note size limit" };
  }
  let sv: Uint8Array;
  try {
    sv = Y.encodeStateVectorFromUpdate(bytes);
  } catch {
    inc("seed.invalid");
    return { ok: false, code: "invalid_state", message: "state is not a Yjs update" };
  }
  if (typeof textSha256 === "string" && textSha256 !== "") {
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, bytes);
      const sha = createHash("sha256").update(doc.getText("content").toString(), "utf8").digest("hex");
      if (sha !== textSha256.toLowerCase()) {
        // Ids only: never a path or text (log hygiene).
        console.warn(`[seed-on-register] textSha256 mismatch for ${docId ?? "(new id)"}`);
      }
    } catch {
      inc("seed.invalid");
      return { ok: false, code: "invalid_state", message: "state is not a Yjs update" };
    } finally {
      doc.destroy();
    }
  }
  return { ok: true, state: { bytes, sv } };
}

export interface SeedCandidate {
  /** Caller's own key (the item index), echoed back. */
  key: number;
  docId: string;
  state: ParsedState;
  /** True when this call inserted the row; false for a same-id existing row. */
  created: boolean;
}

/**
 * Apply the states of rows that may receive one. Call it AFTER the register
 * connection is released (the doc lock and `loadDocState` each take their own
 * pool slot) and BEFORE `registry-changed` is published, so a receiver's pull
 * finds content and not a 0-byte placeholder.
 */
export async function seedRegistered(
  vaultId: string,
  userId: string,
  candidates: SeedCandidate[],
): Promise<Map<number, SeedFields>> {
  const out = new Map<number, SeedFields>();
  if (candidates.length === 0) return out;

  // The SAME resolver docs/batch asks (`syncPermission`), so a row the caller
  // could create but not edit (a personal vault-level `view` lifted by a folder
  // grant edge) answers `no_write_access` instead of a write the push route
  // would refuse. A created row usually resolves to edit via authorship.
  const resolverCache = createResolverCache();
  await resolverCache.prefetch(pool, [...new Set(candidates.map((c) => c.docId))]);
  const permitted: SeedCandidate[] = [];
  for (const c of candidates) {
    const perm = await syncPermission(userId, c.docId, pool, resolverCache);
    if (perm !== "edit") {
      console.warn(`[seed-on-register] registered ${c.docId} but the caller cannot edit it`);
      out.set(c.key, { seeded: false, content: "refused", reason: "no_write_access" });
      continue;
    }
    permitted.push(c);
  }

  // Covered check first, for rows that existed before this call: a retry after
  // a lost response must read as success, never as `conflict` on our own write.
  // A row this call created cannot already hold our ops, so it skips the read.
  const toApply: SeedCandidate[] = [];
  for (const c of permitted) {
    if (!c.created) {
      let covered = false;
      try {
        covered = await serverStateCovers(vaultId, c.docId, c.state.bytes);
      } catch {
        covered = false;
      }
      if (covered) {
        out.set(c.key, seededFields("covered", c.state.sv));
        continue;
      }
    }
    toApply.push(c);
  }

  // `expectEmpty` is what makes this a SEED: re-checked under the per-doc lock on
  // both the live and the detached branch, and it is the flag `applyDocPush`
  // turns into `BULK_SEED_ORIGIN`, which the version/checkpoint layer treats as
  // first content rather than an edit.
  const items: DocApplyItem[] = toApply.map((c) => ({
    docId: c.docId,
    update: c.state.bytes,
    expectEmpty: true,
  }));
  const startedAt = Date.now();
  const applied = await applyDocPushBatch(vaultId, items, { userId });
  let appliedBytes = 0;
  applied.forEach((res, i) => {
    const c = toApply[i];
    switch (res.outcome) {
      case "applied":
        appliedBytes += c.state.bytes.length;
        out.set(c.key, seededFields("applied", c.state.sv));
        return;
      case "skipped":
        // The merge captured nothing: every op was already there.
        out.set(c.key, seededFields("covered", c.state.sv));
        return;
      case "conflict":
        out.set(c.key, { seeded: false, content: "conflict", reason: "conflict" });
        return;
      default:
        out.set(c.key, { seeded: false, content: "refused", reason: res.code ?? "error" });
    }
  });
  recordSeedOutcomes(vaultId, out, appliedBytes, Date.now() - startedAt);
  return out;
}

/**
 * Count this call's outcomes and log ONE summary line for it (§8). Ids and
 * counts only, never paths or text:
 *
 *   [seed-on-register] vault=<id> candidates=N applied=N covered=N conflict=N refused=N refusedBy={code:N} appliedBytes=N ms=N
 */
function recordSeedOutcomes(
  vaultId: string,
  out: Map<number, SeedFields>,
  appliedBytes: number,
  ms: number,
): void {
  const counts = { applied: 0, covered: 0, conflict: 0, refused: 0 };
  const refusedBy: Record<string, number> = {};
  for (const f of out.values()) {
    if (f.content === "applied") counts.applied++;
    else if (f.content === "covered") counts.covered++;
    else if (f.content === "conflict") counts.conflict++;
    else if (f.content === "refused") {
      counts.refused++;
      const code = f.reason ?? "error";
      refusedBy[code] = (refusedBy[code] ?? 0) + 1;
    }
  }
  inc("seed.applied", counts.applied);
  inc("seed.covered", counts.covered);
  inc("seed.conflict", counts.conflict);
  inc("seed.refused", counts.refused);
  inc("seed.appliedBytes", appliedBytes);
  console.info(
    `[seed-on-register] vault=${vaultId} candidates=${out.size} applied=${counts.applied} ` +
      `covered=${counts.covered} conflict=${counts.conflict} refused=${counts.refused} ` +
      `refusedBy=${JSON.stringify(refusedBy)} appliedBytes=${appliedBytes} ms=${ms}`,
  );
}

function seededFields(content: "applied" | "covered", sv: Uint8Array): SeedFields {
  const fields: SeedFields = { seeded: true, content, sv: Buffer.from(sv).toString("base64") };
  if (content === "covered") fields.reason = "covered";
  return fields;
}

/** The fields for an item that sent state but was never a seed candidate. */
export function unseededFields(reason: string, content: "skipped" | "refused"): SeedFields {
  // `skipped` is an adopt onto a DIFFERENT winner id; `refused` a register-time refusal.
  inc(content === "skipped" ? "seed.adopted" : "seed.refused");
  return { seeded: false, content, reason };
}
