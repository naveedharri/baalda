// "New skill": the app's form dialog (AddMarketplaceDialog's shell), not the
// confirm dialog. The name is the slash command teammates type, checked as you
// type (format, taken, claude.ai's reserved words); the optional "when to use
// it" becomes SKILL.md's description, so the skill starts out usable.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isValidSkillName, skillNameNeedsWarning } from "../../lib/skills/validate";
import { BusyButton } from "./parts";

/** SKILL.md's `description` limit (docs/SKILLS.md §1.1). */
const DESCRIPTION_MAX = 1024;

/** Typing "Deploy notes" gives "deploy-notes": lowercase, spaces and underscores to hyphens. */
function tidyName(raw: string): string {
  return raw.toLowerCase().replace(/[\s_]+/g, "-");
}

export function NewSkillDialog({
  takenNames,
  onCreate,
  onClose,
}: {
  /** The vault's skill names, lowercased. */
  takenNames: ReadonlySet<string>;
  /** Creates it and opens its page; resolves to an error message, or null when done. */
  onCreate: (name: string, description: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const createRef = useRef<HTMLButtonElement | null>(null);

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

  const trimmed = name.replace(/^-+|-+$/g, "");
  const taken = trimmed !== "" && takenNames.has(trimmed);
  const valid = isValidSkillName(trimmed) && !taken;
  const status: { tone: "ok" | "bad" | "hint"; text: string } =
    trimmed === ""
      ? { tone: "hint", text: "Lowercase letters, digits and hyphens. It can't be changed later." }
      : taken
        ? { tone: "bad", text: `Your team already has /${trimmed}.` }
        : !isValidSkillName(trimmed)
          ? { tone: "bad", text: "Use lowercase letters, digits and single hyphens, up to 64 characters." }
          : { tone: "ok", text: `Teammates will use it as /${trimmed}` };

  const create = async () => {
    if (!valid) return;
    setError(null);
    const failure = await onCreate(trimmed, description.trim());
    if (failure) setError(failure);
  };

  return createPortal(
    <div className="modal-backdrop" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div
        className="modal skills-form-dialog skills-new-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="New skill"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="skills-form-head">
          <h2 className="confirm-title">New skill</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        <p className="skills-form-intro">
          Name it and say when your team's AI should use it. You'll write its instructions next.
        </p>

        <label className="skills-field-label" htmlFor="new-skill-name">Name</label>
        <label className="skills-prefix-input">
          <span className="skills-slash" aria-hidden="true">/</span>
          <input
            id="new-skill-name"
            autoFocus
            value={name}
            placeholder="release-notes"
            spellCheck={false}
            autoComplete="off"
            maxLength={80}
            onChange={(e) => setName(tidyName(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && valid) createRef.current?.click();
            }}
          />
        </label>
        <div className={`skills-name-status is-${status.tone}`} aria-live="polite">
          {status.tone === "ok" && <span aria-hidden="true">✓ </span>}
          {status.text}
        </div>
        {skillNameNeedsWarning(trimmed) && (
          <div className="skills-warning">claude.ai refuses names with "claude" or "anthropic".</div>
        )}

        <label className="skills-field-label" htmlFor="new-skill-desc">
          When should AI use it? <span className="skills-field-optional">Optional</span>
        </label>
        <textarea
          id="new-skill-desc"
          className="skills-desc-input"
          value={description}
          rows={3}
          maxLength={DESCRIPTION_MAX}
          placeholder="e.g. Use when writing release notes or a changelog for the app."
          onChange={(e) => setDescription(e.target.value.replace(/\n/g, " "))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && valid) createRef.current?.click();
          }}
        />
        <div className="skills-desc-count">
          {description.length > DESCRIPTION_MAX - 200 ? `${description.length} / ${DESCRIPTION_MAX}` : ""}
        </div>

        {error && <div className="auth-error">{error}</div>}

        <div className="confirm-actions skills-form-actions">
          <button type="button" className="ghost-pill" onClick={onClose}>Cancel</button>
          <BusyButton ref={createRef} className="primary" busyLabel="Creating…" disabled={!valid} onClick={create}>
            Create skill
          </BusyButton>
        </div>
      </div>
    </div>,
    document.body,
  );
}
