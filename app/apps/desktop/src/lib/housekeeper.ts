// SPDX-License-Identifier: Apache-2.0
// Public wire contract for the optional Housekeeper service; no model logic.
export interface HousekeeperStatus { requiresPro?: boolean; available: boolean; provider: string; model: string }
export interface HousekeeperSuggestion {
  id: string;
  label?: string;
  sourcePath: string;
  targetPath: string;
  before: string;
  after: string;
  model: string;
}
export interface HousekeeperScan {
  considered: number;
  remaining: number;
  nextOffset: number;
  suggestions: HousekeeperSuggestion[];
}
export interface HousekeeperEdit { revision: string; undoId: string | null }

export interface DiagnosticInput {
  checks: { id: string; count: number }[];
  sync: { pending: number; failed: number; unsynced: number };
  context?: {
    verdict: string; totalNotes: number | null; totalFiles: number | null;
    contentBytes: number | null; historyBytes: number | null; indexBytes: number | null; largestFileBytes: number | null;
    serverState: string; serverOnlyFiles: number; deviceOnlyFiles: number;
    issues: { kind: string; count: number }[];
  };
}
export interface DiagnosticReview {
  model: string;
  checked: number;
  findings: { id: string; count: number; priority: "now" | "soon" | "later" | "review"; label: string; title: string; guidance: string; action?: "inspect" | "rebuild-index" | "review-links" | "sync-now" | "review-storage" | "configure-sync" | "retry-files" | "review-renames" | "review-empty" | "review-properties" | "review-access" | "review-recovery"; actionReason?: string }[];
}

export interface StewardProvider { name: "openrouter"; apiKey: string; model: string; mode: "decisions" | "chat" }
