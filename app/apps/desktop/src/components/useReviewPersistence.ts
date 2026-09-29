/* Keeps the review's pending items across restarts (see reviewModel.ts
   "Persistence"). On each vault open: note where the in-memory report stands,
   load this vault's saved items, prune the ones whose copy is gone, and
   re-record the rest. Then every report or resolution change is written back.
   Nothing is written until the load finished, so a fast first record can
   never erase what the last session saved. */
import { useEffect } from "react";
import * as ipc from "../lib/ipc";
import { useStore } from "../store";
import { reconcileReport } from "../lib/sync/reconcileReport";
import {
  prunePersisted,
  readPersisted,
  reviewState,
  serializeReview,
  writePersisted,
} from "./reviewModel";

export function useReviewPersistence(): void {
  const vaultPath = useStore((s) => s.vault?.path ?? null);
  const epoch = useStore((s) => s.vault?.epoch);

  useEffect(() => {
    if (!vaultPath) return;
    const key = vaultPath;
    // The report is app-global and never cleared; only what is recorded from
    // here on belongs to this vault.
    const base = reconcileReport.items().length;
    let loaded = false;
    let cancelled = false;

    const save = () => {
      if (!loaded || cancelled) return;
      writePersisted(key, serializeReview(reconcileReport.items().slice(base), reviewState.get()));
    };

    (async () => {
      const saved = readPersisted(key);
      if (saved && saved.items.length > 0) {
        let existing: Set<string> | null = null;
        try {
          const copies = await ipc.listTrashCopies(epoch);
          existing = new Set(copies.map((c) => `${c.stamp}/${c.relPath}`));
        } catch {
          // Unknown: keep every saved item rather than dropping real work.
        }
        if (cancelled) return;
        const seed = prunePersisted(saved, existing);
        for (const it of seed) {
          reconcileReport.record({
            kind: it.kind,
            path: it.path,
            ...(it.docId ? { docId: it.docId } : {}),
            ...(it.newPath ? { newPath: it.newPath } : {}),
            ...(it.detail ? { detail: it.detail } : {}),
          });
        }
      }
      if (cancelled) return;
      loaded = true;
      save();
    })();

    const offReport = reconcileReport.subscribe(save);
    const offReview = reviewState.subscribe(save);
    return () => {
      cancelled = true;
      offReport();
      offReview();
    };
  }, [vaultPath, epoch]);
}
