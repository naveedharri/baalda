// "Add a marketplace": the app's form dialog (InvitePeopleDialog's shell:
// header, body, right-aligned footer), not the confirm dialog. A live check
// peeks at the repo as you type, so Add only lights up for something real.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { parseRepoInput, peekMarketplace, formatLabel, type GitHubReader, type MarketplacePeek } from "../../lib/skills/marketplace";
import { Spinner } from "../Spinner";
import { BusyButton, GitHubGlyph } from "./parts";

const CHECK_DELAY_MS = 400;

type Check =
  | { status: "idle" }
  | { status: "invalid" }
  | { status: "checking" }
  | { status: "ok"; peek: MarketplacePeek; repo: string; ref: string | null }
  | { status: "error"; message: string };

export function AddMarketplaceDialog({
  quickPicks,
  reader,
  onAdd,
  onClose,
}: {
  /** Popular repos the vault doesn't have yet. */
  quickPicks: readonly string[];
  /** Reads GitHub with the admin's token when this computer has one. */
  reader: () => Promise<GitHubReader>;
  /** Saves the source and opens it; resolves to an error message, or null when done. */
  onAdd: (repo: string, ref: string | null) => Promise<string | null>;
  onClose: () => void;
}) {
  const [repo, setRepo] = useState("");
  const [ref, setRef] = useState("");
  const [showRef, setShowRef] = useState(false);
  const [check, setCheck] = useState<Check>({ status: "idle" });
  const [error, setError] = useState<string | null>(null);
  const addRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // Live check: format first, then a cheap peek, ~400ms after typing stops.
  useEffect(() => {
    setError(null);
    if (!repo.trim()) {
      setCheck({ status: "idle" });
      return;
    }
    const parsed = parseRepoInput(repo, showRef ? ref : null);
    if (!parsed) {
      setCheck({ status: "invalid" });
      return;
    }
    let cancelled = false;
    setCheck({ status: "checking" });
    const t = setTimeout(() => {
      void reader()
        .then((r) => peekMarketplace(r, parsed))
        .then(
          (peek) => {
            if (!cancelled) setCheck({ status: "ok", peek, repo: parsed.repo, ref: parsed.ref });
          },
          (e) => {
            if (!cancelled) setCheck({ status: "error", message: e instanceof Error ? e.message : String(e) });
          },
        );
    }, CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [repo, ref, showRef, reader]);

  const ready = check.status === "ok";
  const add = async () => {
    if (check.status !== "ok") return;
    const failure = await onAdd(check.repo, check.ref);
    if (failure) setError(failure);
    else onClose();
  };

  return createPortal(
    <div className="modal-backdrop" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div
        className="modal skills-form-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Add a marketplace"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="skills-form-head">
          <h2 className="confirm-title">Add a marketplace</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>✕</button>
        </div>

        <label className="skills-prefix-input">
          <GitHubGlyph />
          <input
            autoFocus
            value={repo}
            placeholder="owner/repo or github.com link"
            aria-label="Repository"
            onChange={(e) => setRepo(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && ready) addRef.current?.click();
            }}
          />
        </label>
        <div className="field-hint">Works with Claude and Codex plugin marketplaces, or any repo of skills.</div>

        {quickPicks.length > 0 && !repo && (
          <div className="skills-chips skills-dialog-chips">
            {quickPicks.map((p) => (
              <button key={p} type="button" className="skills-chip" onClick={() => setRepo(p)}>
                {p}
              </button>
            ))}
          </div>
        )}

        {showRef ? (
          <input
            className="skills-dialog-ref"
            value={ref}
            placeholder="Branch or tag"
            aria-label="Branch or tag"
            onChange={(e) => setRef(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && ready) addRef.current?.click();
            }}
          />
        ) : (
          <button type="button" className="link-btn skills-dialog-options" onClick={() => setShowRef(true)}>
            Use a branch or tag
          </button>
        )}

        <div className="skills-check" aria-live="polite">
          {check.status === "checking" ? (
            <span className="skills-check-row"><Spinner size="xs" /> Checking…</span>
          ) : check.status === "ok" ? (
            check.peek.skills > 0 ? (
              <span className="skills-check-row is-ok">
                ✓ {formatLabel(check.peek.format)} · {check.peek.skills} {check.peek.skills === 1 ? "skill" : "skills"}
              </span>
            ) : (
              <span className="skills-check-row is-ok">✓ Found it, but no skills were spotted yet. You can still add it.</span>
            )
          ) : check.status === "invalid" ? (
            <span className="skills-check-row">Use owner/repo, or paste the repository's GitHub link.</span>
          ) : check.status === "error" ? (
            <span className="skills-check-row is-bad">{check.message}</span>
          ) : null}
        </div>
        {error && <div className="auth-error">{error}</div>}

        <div className="confirm-actions skills-form-actions">
          <button type="button" className="ghost-pill" onClick={onClose}>Cancel</button>
          <BusyButton ref={addRef} className="primary" busyLabel="Adding…" disabled={!ready} onClick={add}>
            Add
          </BusyButton>
        </div>
      </div>
    </div>,
    document.body,
  );
}
