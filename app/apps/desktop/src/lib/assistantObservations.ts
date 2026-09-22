// SPDX-License-Identifier: Apache-2.0
import type { DiagnosticInput } from "./housekeeper";
import type { VaultHealthSnapshot } from "./health/types";

/** Whole-vault measurements; opaque categories and numeric evidence leave the device.
 * Paths, raw error messages and note content remain local until a specific repair. */
export function assistantObservations(snapshot: VaultHealthSnapshot): DiagnosticInput | null {
  if (!snapshot.checks || snapshot.loading) return null;
  const { report, stats, inventory } = snapshot;
  const kinds = [...new Set(report.issues.map(issue => issue.kind))].sort();
  return {
    checks: snapshot.checks.results.map(check => ({ id: check.id, count: check.count })),
    sync: { pending: report.counts?.pending ?? 0, failed: report.counts?.failed ?? 0, unsynced: report.counts?.unsynced ?? 0 },
    context: {
      verdict: report.verdict,
      totalNotes: inventory.localReady ? inventory.local.notes : null,
      totalFiles: inventory.localReady ? inventory.local.total : null,
      contentBytes: stats ? stats.notes.bytes + stats.attachments.bytes + stats.otherFiles.bytes : null,
      historyBytes: stats?.history.bytes ?? null,
      indexBytes: stats?.index.bytes ?? null,
      largestFileBytes: stats ? Math.max(0, ...stats.largestNotes.map(n => n.bytes), ...stats.largestFiles.map(n => n.bytes)) : null,
      serverState: inventory.serverState,
      serverOnlyFiles: inventory.serverOnlyFiles.length,
      deviceOnlyFiles: inventory.deviceOnlyFiles.length,
      issues: kinds.map(kind => ({ kind, count: report.issues.filter(issue => issue.kind === kind).length })),
    },
  };
}
