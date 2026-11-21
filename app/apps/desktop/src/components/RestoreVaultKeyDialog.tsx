// "Restore with vault key": a proper window for the 24 words. Paste them (or
// the whole saved key file, or open that file), watch them fill the numbered
// grid, then Restore. The words are checked against the server's `vk_check`
// before anything is stored (`session.restoreWithVaultKey`), so a wrong key
// changes nothing and the window stays open with the reason.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { AsyncButton } from "./AsyncButton";
import { toast } from "../lib/toast";
import * as ipc from "../lib/ipc";
import { currentVaultKeySession, vaultKeysNudge } from "../lib/vaultKeys/runtime";
import { KEY_WORD_COUNT, keyInputStatus, readKeyInput, restoreErrorMessage } from "../lib/vaultKeys/restoreInput";

/** A saved key file is a few hundred bytes; refuse anything that is not. */
const KEY_FILE_MAX_BYTES = 64 * 1024;

export function RestoreVaultKeyDialog({
  vaultId,
  vaultName,
  onClose,
  onRestored,
}: {
  vaultId: string;
  vaultName?: string | null;
  onClose: () => void;
  onRestored?: () => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const input = useMemo(() => readKeyInput(text), [text]);
  const status = keyInputStatus(input);
  const titleId = useId();
  const areaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    areaRef.current?.focus({ preventScroll: true });
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  const change = (next: string) => {
    setText(next);
    setError(null);
  };

  const openKeyFile = async () => {
    try {
      const picked = await openDialog({ multiple: false, directory: false, filters: [{ name: "Text", extensions: ["txt"] }] });
      if (typeof picked !== "string") return;
      const bytes = await ipc.readExternalFile(picked, KEY_FILE_MAX_BYTES);
      change(new TextDecoder().decode(bytes));
    } catch {
      setError("That file could not be read. Open the .txt file Baalda saved your key to, or paste the words.");
    }
  };

  const restore = async () => {
    if (!input.phrase) return;
    const session = currentVaultKeySession();
    let result;
    try {
      result = await session?.restoreWithVaultKey(vaultId, input.phrase);
    } catch {
      result = undefined;
    }
    const message = restoreErrorMessage(result);
    if (message) {
      setError(message);
      return;
    }
    toast("Vault key restored on this computer.", "success");
    setText("");
    vaultKeysNudge();
    onRestored?.();
    onClose();
  };

  const slots = Array.from({ length: KEY_WORD_COUNT }, (_, i) => input.words[i] ?? null);
  const unknown = new Set(input.unknown);

  const dialog = (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") e.preventDefault();
      }}
    >
      <div
        className="modal restore-key-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="restore-key-close" aria-label="Close" onClick={onClose}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
        <div className="restore-key-badge" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="8" cy="15" r="4" />
            <path d="M11 12l9-9M17 6l3 3M15 8l2 2" />
          </svg>
        </div>
        <h2 id={titleId} className="restore-key-title">
          Restore with vault key
        </h2>
        <p className="restore-key-subtitle">
          Unlock {vaultName ? <strong>{vaultName}</strong> : "this vault"} on this computer with the 24 words you saved.
        </p>

        <textarea
          ref={areaRef}
          className="restore-key-input"
          value={text}
          rows={3}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="Paste your 24 words here"
          aria-label="Vault key words"
          aria-describedby={`${titleId}-status`}
          onChange={(e) => change(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && input.phrase) {
              e.preventDefault();
              void restore();
            }
          }}
        />

        <ol className="restore-key-grid" aria-hidden="true">
          {slots.map((w, i) => (
            <li key={i} className={`restore-key-slot${w ? " filled" : ""}${unknown.has(i) ? " bad" : ""}`}>
              <span className="restore-key-num">{i + 1}</span>
              <span className="restore-key-word">{w ?? ""}</span>
            </li>
          ))}
        </ol>

        <div className="restore-key-statusrow">
          <span id={`${titleId}-status`} className={`restore-key-status tone-${status.tone}`} role="status">
            {status.tone === "ok" && (
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12.5l4.5 4.5L19 7.5" />
              </svg>
            )}
            {status.text}
          </span>
          <button type="button" className="link-btn restore-key-open" onClick={() => void openKeyFile()}>
            Open key file…
          </button>
        </div>

        {error && (
          <div className="restore-key-error" role="alert">
            {error}
          </div>
        )}

        <p className="restore-key-note">
          The words are checked before anything is saved, so a wrong key changes nothing. Your notes on this computer
          are not touched.
        </p>

        <div className="restore-key-actions">
          <button type="button" className="ghost-pill" onClick={onClose}>
            Cancel
          </button>
          <AsyncButton className="primary" spinnerTone="on-accent" disabled={!input.phrase} onClick={restore}>
            Restore
          </AsyncButton>
        </div>
      </div>
    </div>
  );
  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
