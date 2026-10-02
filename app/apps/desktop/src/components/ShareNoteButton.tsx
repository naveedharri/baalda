import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ApiError, type PublicLink } from "../lib/api";
import { authManager } from "../lib/auth/authManager";
import { copyText } from "../lib/clipboard";
import { noteLabel } from "../lib/notePath";
import { buildNoteLink } from "../lib/shareLink";
import { toast } from "../lib/toast";
import { useStore } from "../store";
import { CheckMark } from "./Spinner";
import { Switch } from "./Switch";

/**
 * The header's Share button: opens a dialog that hands out the two kinds of
 * link to this note. Still deliberately not a permissions surface — Access
 * owns who can do what.
 *
 * Team link: the existing https://<server>/open/note/… link. It carries a vault
 * id and a doc_id and nothing else — opening it resolves both against whoever
 * clicks, so sending it to someone without a grant hands them nothing.
 *
 * Public link: a server-minted https://<server>/p/<token> page anyone can read
 * in a browser. The token IS the capability, so it is minted only when the
 * switch is turned on — never as a side effect of opening the dialog — and its
 * existence is re-fetched on every open (a stale "not published" on a security
 * affordance is worse than the extra request). Turning the switch off revokes
 * it; the old URL stops working.
 */
export function ShareNoteButton({ docId }: { docId: string }) {
  const orgId = useStore((s) => s.session?.activeOrganizationId ?? null);
  const [open, setOpen] = useState(false);

  // A different note is a different link: never carry an open dialog over.
  useEffect(() => setOpen(false), [docId]);

  if (!orgId) return null;

  return (
    <>
      <button
        className={`icon-btn share-btn${open ? " active" : ""}`}
        title="Share this note"
        aria-label="Share this note"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {/* Share glyph: an open tray with an arrow rising out of its
              centre through the open top. */}
          <path d="M4 12v7a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19v-7" />
          <path d="M12 15V3" />
          <path d="M8 7l4-4 4 4" />
        </svg>
      </button>
      {open && <ShareNoteDialog docId={docId} orgId={orgId} onClose={() => setOpen(false)} />}
    </>
  );
}

function ShareNoteDialog({
  docId,
  orgId,
  onClose,
}: {
  docId: string;
  orgId: string;
  onClose: () => void;
}) {
  const notePath = useStore((s) => s.openNote?.path ?? null);
  // `undefined` while the first fetch is in flight; null = not published.
  const [publicLink, setPublicLink] = useState<PublicLink | null | undefined>(undefined);
  const [publicBusy, setPublicBusy] = useState(false);
  const [copied, setCopied] = useState<"team" | "public" | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    authManager.api
      .getPublicLink(docId)
      .then((link) => {
        if (alive) setPublicLink(link);
      })
      .catch(() => {
        if (alive) setPublicLink(null);
      });
    return () => {
      alive = false;
    };
  }, [docId]);

  // The "Copied" tick is a state, so it has to clear itself.
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(null), 1600);
    return () => window.clearTimeout(id);
  }, [copied]);

  const copy = useCallback(async (kind: "team" | "public", url: string) => {
    if (await copyText(url)) {
      setCopied(kind);
      return true;
    }
    toast("Couldn't copy the link", "error");
    return false;
  }, []);

  const copyTeam = () =>
    // Built on the server URL so it's an https link — chat apps make those
    // clickable, where a bare baalda:// scheme had to be copy-pasted. The
    // server's /open/note page bounces the click into the app.
    void copy("team", buildNoteLink({ orgId, docId }, useStore.getState().serverUrl));

  const setPublished = async (next: boolean) => {
    setPublicBusy(true);
    try {
      if (next) {
        const link = await authManager.api.createPublicLink(docId);
        setPublicLink(link);
        // Publishing is almost always followed by pasting it somewhere. If the
        // clipboard refuses, the url is on screen with its own Copy button.
        if (await copyText(link.url)) {
          setCopied("public");
          toast("Public link created and copied");
        }
      } else {
        await authManager.api.revokePublicLink(docId);
        setPublicLink(null);
        toast("Public link turned off — the old link no longer works");
      }
    } catch (e) {
      toast(
        e instanceof ApiError
          ? e.message
          : next
            ? "Couldn't create the public link"
            : "Couldn't turn off the public link",
        "error",
      );
    } finally {
      setPublicBusy(false);
    }
  };

  const published = publicLink != null;
  // Kept after unpublishing so the row collapses with its text still in it.
  const [lastUrl, setLastUrl] = useState("");
  useEffect(() => {
    if (publicLink) setLastUrl(publicLink.url);
  }, [publicLink]);
  const shownUrl = publicLink?.url ?? lastUrl;
  const title = notePath ? noteLabel(notePath) : "this note";

  // Portalled to <body>, like UpgradeDialog: the header row's floating pill is
  // a containing block for anything positioned inside it.
  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal share-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Share ${title}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span className="share-dialog-title">
            Share this note
            <span className="share-dialog-note">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                <path d="M14 3v5h5" />
              </svg>
              <span>{title}</span>
            </span>
          </span>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="share-options">
          <section className="share-option">
            <span className="share-option-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="9" cy="8" r="3.2" />
                <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
                <path d="M16 5.2a3 3 0 0 1 0 5.6M18 19a5.4 5.4 0 0 0-2.6-4.6" />
              </svg>
            </span>
            <span className="share-option-copy">
              <strong>Team link</strong>
              <span>Opens for people in this vault who have access.</span>
            </span>
            <button type="button" className="ghost-pill sm share-copy-btn" onClick={copyTeam}>
              {copied === "team" ? (
                <>
                  <CheckMark size="xs" /> Copied
                </>
              ) : (
                "Copy link"
              )}
            </button>
          </section>

          <section className={`share-option${published ? " is-on" : ""}`}>
            <span className="share-option-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
              </svg>
            </span>
            <span className="share-option-copy">
              <strong>Publish to the web</strong>
              <span>Anyone with the link can read it in a browser.</span>
            </span>
            {/* The switch stays put while it works (disabled, not swapped for a
                spinner) so the row never changes width mid-click. */}
            <Switch
              checked={published}
              disabled={publicLink === undefined || publicBusy}
              onChange={(next) => void setPublished(next)}
              ariaLabel="Publish to the web"
            />
            {/* Always mounted and animated open/closed (grid 0fr → 1fr), with
                the last url kept while it collapses — so publishing slides the
                row in instead of making the dialog jump. */}
            <div className={`share-url-reveal${published ? " open" : ""}`} aria-hidden={!published}>
              <div className="share-url-row">
                <input
                  className="share-url"
                  readOnly
                  tabIndex={published ? 0 : -1}
                  value={shownUrl}
                  aria-label="Public link"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <button
                  type="button"
                  className="ghost-pill sm share-copy-btn"
                  tabIndex={published ? 0 : -1}
                  onClick={() => publicLink && void copy("public", publicLink.url)}
                >
                  {copied === "public" ? (
                    <>
                      <CheckMark size="xs" /> Copied
                    </>
                  ) : (
                    "Copy"
                  )}
                </button>
                <p className="share-url-hint">Turn this off to make the link stop working.</p>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}
