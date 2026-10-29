// The owner's review at conversion: every existing MCP token, Claude/ChatGPT
// connection and public link the server lists, all checked. Unchecked ones are
// excluded (never given the vault key; they keep working until encryption
// finishes, then need reconnecting). Built on the shared ConfirmDialog and the
// settings row classes; wording and sorting live in `lib/vaultKeys/conversionReview.ts`.

import { useState } from "react";
import type { AllowlistCandidate } from "../lib/api";
import {
  candidateDetail,
  candidateKey,
  candidateTitle,
  REVIEW_INTRO,
  REVIEW_TITLE,
  REVIEW_UNCHECKED_NOTE,
} from "../lib/vaultKeys/conversionReview";
import { ConfirmDialog } from "./ConfirmDialog";
import { relTime } from "./McpTab";

export function ConversionReviewDialog({
  candidates,
  onSubmit,
  onLater,
}: {
  candidates: AllowlistCandidate[];
  /** `keep`: the candidate keys left checked. */
  onSubmit: (keep: ReadonlySet<string>) => void;
  onLater: () => void;
}) {
  const [keep, setKeep] = useState<Set<string>>(() => new Set(candidates.map(candidateKey)));
  const unchecked = candidates.length - keep.size;
  const toggle = (key: string, on: boolean) =>
    setKeep((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  return (
    <ConfirmDialog
      title={REVIEW_TITLE}
      tone="accent"
      confirmLabel={unchecked ? `Continue without ${unchecked}` : "Keep all and continue"}
      cancelLabel="Not now"
      onConfirm={() => onSubmit(keep)}
      onCancel={onLater}
    >
      <p>{REVIEW_INTRO}</p>
      {candidates.map((c) => {
        const key = candidateKey(c);
        return (
          <label key={key} className="menu-row">
            <input type="checkbox" checked={keep.has(key)} onChange={(e) => toggle(key, e.target.checked)} />
            <span className="menu-row-label">
              {candidateTitle(c)}
              <span className="field-hint">{candidateDetail(c, relTime)}</span>
            </span>
          </label>
        );
      })}
      <p className="muted">{REVIEW_UNCHECKED_NOTE}</p>
    </ConfirmDialog>
  );
}
