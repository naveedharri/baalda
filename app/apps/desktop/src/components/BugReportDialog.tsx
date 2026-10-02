import { useEffect, useMemo, useRef, useState, type ClipboardEvent } from "react";
import { createPortal } from "react-dom";
import { ApiError, type BugReportDetails } from "../lib/api";
import { authManager } from "../lib/auth/authManager";
import { CLIENT_VERSION } from "../lib/clientVersion";
import { platformClass } from "../lib/platform";
import { useStore } from "../store";
import { AsyncButton } from "./AsyncButton";

/** Mirrors the server's caps (src/http/routes/bug-reports.ts). */
const MAX_CHARS = 5000;
const MAX_FILES = 3;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
/** Mirrors the server's ATTACHMENT_TYPES keys — it re-checks every file. */
const ALLOWED_EXTS = [
  "png", "jpg", "jpeg", "gif", "webp", "heic", "pdf", "txt", "log", "md", "csv", "json", "zip", "mp4", "mov", "webm",
];
const ACCEPT = ALLOWED_EXTS.map((e) => `.${e}`).join(",");

interface Picked {
  id: number;
  file: File;
  /** Object URL for an image thumbnail, revoked when the file is removed. */
  preview: string | null;
}

function extOf(name: string): string {
  return name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** File → base64 (no `data:` prefix), the shape the server expects. */
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the file"));
    reader.readAsDataURL(file);
  });
}

function isVideoLink(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * "Report a bug" — opened from the bug icon beside the account bar. Emails the
 * server operator's BUG_REPORT_EMAIL (the server owns the address; the app
 * only knows the feature is on via `/api/auth-methods`). Replies go to the
 * reporter. A Loom link and up to three files (picked, or a screenshot pasted
 * into the description) travel with it as real email attachments. App details
 * are opt-out and shown in full before sending: nothing travels that the
 * person did not see.
 */
export function BugReportDialog({ onClose }: { onClose: () => void }) {
  const email = useStore((s) => s.session?.user.email ?? "");
  const serverUrl = useStore((s) => s.serverUrl);
  const vaultName = useStore((s) => s.vault?.name ?? null);
  const syncStatus = useStore((s) => s.syncStatus);
  const [message, setMessage] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [files, setFiles] = useState<Picked[]>([]);
  const [includeDetails, setIncludeDetails] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Thumbnails are object URLs; let them go with the dialog.
  const filesRef = useRef(files);
  filesRef.current = files;
  useEffect(
    () => () => {
      for (const f of filesRef.current) if (f.preview) URL.revokeObjectURL(f.preview);
    },
    [],
  );

  const details = useMemo<BugReportDetails>(
    () => ({
      appVersion: CLIENT_VERSION,
      platform: platformClass(),
      serverUrl,
      ...(vaultName ? { vault: vaultName } : {}),
      syncStatus,
    }),
    [serverUrl, vaultName, syncStatus],
  );
  const detailRows: Array<[string, string]> = [
    ["App version", details.appVersion ?? ""],
    ["Platform", details.platform ?? ""],
    ["Server", details.serverUrl ?? ""],
    ...(details.vault ? ([["Vault", details.vault]] as Array<[string, string]>) : []),
    ["Sync status", details.syncStatus ?? ""],
  ];

  let host = serverUrl;
  try {
    host = new URL(serverUrl).host;
  } catch {
    /* keep the raw value */
  }

  const addFiles = (incoming: File[]) => {
    setError(null);
    const next = [...files];
    for (const file of incoming) {
      if (!ALLOWED_EXTS.includes(extOf(file.name))) {
        setError(`${file.name} can't be attached. Use an image, PDF, text or log file, JSON, ZIP or a short video.`);
        continue;
      }
      if (next.length >= MAX_FILES) {
        setError(`You can attach up to ${MAX_FILES} files.`);
        break;
      }
      if (file.size > MAX_FILE_BYTES) {
        setError(`${file.name} is over ${formatBytes(MAX_FILE_BYTES)}. For a longer recording, paste a Loom link instead.`);
        continue;
      }
      const total = next.reduce((n, f) => n + f.file.size, 0) + file.size;
      if (total > MAX_TOTAL_BYTES) {
        setError(`Attachments can add up to ${formatBytes(MAX_TOTAL_BYTES)} in total.`);
        continue;
      }
      next.push({
        id: nextId.current++,
        file,
        preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
      });
    }
    setFiles(next);
  };

  const removeFile = (id: number) => {
    setFiles((prev) => {
      const gone = prev.find((f) => f.id === id);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return prev.filter((f) => f.id !== id);
    });
  };

  // A screenshot pasted into the description becomes an attachment (text
  // pastes as text, as usual).
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    e.preventDefault();
    const stamp = new Date().toISOString().slice(0, 19).replace("T", " ").replace(/:/g, ".");
    addFiles(
      images.map(
        (f, i) =>
          new File([f], `Screenshot ${stamp}${images.length > 1 ? ` (${i + 1})` : ""}.${extOf(f.name) || "png"}`, {
            type: f.type,
          }),
      ),
    );
  };

  const trimmedLink = videoUrl.trim();
  const linkInvalid = trimmedLink !== "" && !isVideoLink(trimmedLink);

  const send = async () => {
    setError(null);
    try {
      const attachments = await Promise.all(
        files.map(async (f) => ({ name: f.file.name, data: await toBase64(f.file) })),
      );
      await authManager.api.sendBugReport({
        message: message.trim(),
        ...(includeDetails ? { details } : {}),
        ...(trimmedLink ? { videoUrl: trimmedLink } : {}),
        ...(attachments.length ? { attachments } : {}),
      });
      setSent(true);
    } catch (e) {
      const code = e instanceof ApiError ? (e.body as { error?: string } | undefined)?.error : undefined;
      setError(
        e instanceof ApiError
          ? e.status === 429
            ? "You've sent several reports in the last hour. Please try again a little later."
            : e.status === 404
              ? "This server no longer takes bug reports."
              : e.status === 413 || code === "attachments_too_large"
                ? "The attachments are too large. Remove one, or share a Loom link instead."
                : code === "invalid_attachment"
                  ? "One of the files can't be attached. Try a different file type."
                  : code === "invalid_video_link"
                    ? "That video link doesn't look right. Paste the full https:// address."
                    : e.status === 502
                      ? "The report couldn't be emailed just now. Please try again in a minute."
                      : e.message
          : "Couldn't reach the server. Check your connection and try again.",
      );
    }
  };

  const trimmed = message.trim();
  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal bug-report-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Report a bug"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span>Report a bug</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {sent ? (
          <div className="bug-report-sent">
            <span className="bug-report-sent-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12.5l4.5 4.5L19 7.5" />
              </svg>
            </span>
            <strong>Thanks — your report was sent.</strong>
            <p>{email ? <>Any reply will come to {email}.</> : "Thanks for helping make Baalda better."}</p>
            <div className="bug-report-actions">
              <button type="button" className="primary" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <>
            <label className="bug-report-label" htmlFor="bug-report-message">
              What happened?
            </label>
            <textarea
              id="bug-report-message"
              className="bug-report-message"
              autoFocus
              rows={5}
              maxLength={MAX_CHARS}
              placeholder="What you were doing, what you expected, and what happened instead. You can paste a screenshot here."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onPaste={onPaste}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && trimmed && !linkInvalid) {
                  e.preventDefault();
                  void send();
                }
              }}
            />

            <label className="bug-report-label" htmlFor="bug-report-video">
              Loom or video link <span className="bug-report-optional">optional</span>
            </label>
            <input
              id="bug-report-video"
              className={`bug-report-video${linkInvalid ? " is-invalid" : ""}`}
              type="url"
              inputMode="url"
              placeholder="https://www.loom.com/share/…"
              value={videoUrl}
              onChange={(e) => setVideoUrl(e.target.value)}
              aria-invalid={linkInvalid}
            />
            {linkInvalid && <p className="bug-report-field-error">Paste the full link, starting with https://</p>}

            <div className="bug-report-files">
              {files.map((f) => (
                <span key={f.id} className="bug-report-file" title={f.file.name}>
                  {f.preview ? (
                    <img src={f.preview} alt="" />
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                      <path d="M14 3v5h5" />
                    </svg>
                  )}
                  <span className="bug-report-file-name">{f.file.name}</span>
                  <span className="bug-report-file-size">{formatBytes(f.file.size)}</span>
                  <button
                    type="button"
                    className="bug-report-file-remove"
                    aria-label={`Remove ${f.file.name}`}
                    onClick={() => removeFile(f.id)}
                  >
                    ✕
                  </button>
                </span>
              ))}
              {files.length < MAX_FILES && (
                <button type="button" className="ghost-pill sm bug-report-attach" onClick={() => fileInput.current?.click()}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9" />
                  </svg>
                  Attach files
                </button>
              )}
              <input
                ref={fileInput}
                type="file"
                multiple
                accept={ACCEPT}
                hidden
                onChange={(e) => {
                  addFiles([...(e.target.files ?? [])]);
                  e.target.value = "";
                }}
              />
            </div>

            <label className="bug-report-include">
              <input
                type="checkbox"
                checked={includeDetails}
                onChange={(e) => setIncludeDetails(e.target.checked)}
              />
              Include app details
            </label>
            {includeDetails && (
              <dl className="bug-report-details">
                {detailRows.map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd title={v}>{v}</dd>
                  </div>
                ))}
              </dl>
            )}

            {error && (
              <p role="alert" className="auth-error">
                {error}
              </p>
            )}

            <p className="bug-report-note">
              Sent to the team running {host}
              {email ? <>. Replies go to {email}</> : null}.
            </p>
            <div className="bug-report-actions bug-report-buttons">
              <button type="button" className="ghost-pill" onClick={onClose}>
                Cancel
              </button>
              <AsyncButton
                className="primary"
                spinnerTone="on-accent"
                disabled={!trimmed || linkInvalid}
                onClick={send}
              >
                Send report
              </AsyncButton>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
