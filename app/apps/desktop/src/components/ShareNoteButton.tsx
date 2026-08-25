import { useEffect, useRef, useState } from "react";
import { ApiError, type PublicLink } from "../lib/api";
import { authManager } from "../lib/auth/authManager";
import { copyText } from "../lib/clipboard";
import { buildNoteLink } from "../lib/shareLink";
import { toast } from "../lib/toast";
import { useStore } from "../store";
import { CheckMark, Spinner } from "./Spinner";

/**
 * "Copy link to this note" — the header's share affordance.
 *
 * One click opens a two-row choice (private / public); the second click copies.
 * Still deliberately not a permissions surface — Access owns who can do what;
 * this popover only hands out the two kinds of link (and kills the public one).
 *
 * Private: the existing https://<server>/open/note/… link. It carries a vault
 * id and a doc_id and nothing else — opening it resolves both against whoever
 * clicks, so sending it to someone without a grant hands them nothing.
 *
 * Public: a server-minted https://<server>/p/<token> page anyone can read in a
 * browser. The token IS the capability, so it is minted only when the row is
 * clicked — never as a side effect of opening the menu — and its existence is
 * re-fetched on every open (a stale "no public link" on a security affordance
 * is worse than the extra request).
 */
export function ShareNoteButton({ docId }: { docId: string }) {
  const orgId = useStore((s) => s.session?.activeOrganizationId ?? null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [existing, setExisting] = useState<PublicLink | null | "loading">(null);
  const [publicBusy, setPublicBusy] = useState(false);
  // Clipboard write failed after the link was minted: show the url as a
  // click-to-copy row instead of losing it behind an error toast.
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const [fallbackCopied, setFallbackCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // The tick is a state, so it has to be cleared — otherwise switching notes
  // leaves a stale "copied" on a link nobody copied.
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(id);
  }, [copied]);
  useEffect(() => {
    setCopied(false);
    setOpen(false);
    setFallbackUrl(null);
    setFallbackCopied(false);
  }, [docId]);
  useEffect(() => {
    if (!fallbackCopied) return;
    const id = window.setTimeout(() => setFallbackCopied(false), 1600);
    return () => window.clearTimeout(id);
  }, [fallbackCopied]);

  // Close on outside click or Escape (the AccountMenu popover pattern).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Re-fetched on every open, kept component-local: the popover is the only
  // reader, and it must never show stale "no public link exists".
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setExisting("loading");
    authManager.api
      .getPublicLink(docId)
      .then((link) => {
        if (alive) setExisting(link);
      })
      .catch(() => {
        if (alive) setExisting(null);
      });
    return () => {
      alive = false;
    };
  }, [open, docId]);

  if (!orgId) return null;

  const copyPrivate = async () => {
    // Built on the server URL so it's an https link — chat apps make those
    // clickable, where a bare baalda:// scheme had to be copy-pasted. The
    // server's /open/note page bounces the click into the app.
    const link = buildNoteLink({ orgId, docId }, useStore.getState().serverUrl);
    if (await copyText(link)) {
      setCopied(true);
      setOpen(false);
      toast("Link copied — anyone on your team with access can open it");
    } else {
      toast("Couldn't copy the link", "error");
    }
  };

  const copyPublic = async () => {
    setPublicBusy(true);
    setFallbackUrl(null);
    try {
      const link = await authManager.api.createPublicLink(docId);
      setExisting(link);
      if (!(await copyText(link.url))) {
        // The link exists now even though both clipboard paths failed —
        // surface it as a click-to-copy row rather than stranding it behind
        // an error (the fresh click carries its own user activation).
        setFallbackUrl(link.url);
        return;
      }
      setCopied(true);
      setOpen(false);
      toast("Public link copied — anyone with this link can view this note");
    } catch (e) {
      toast(
        e instanceof ApiError ? e.message : "Couldn't create the public link",
        "error",
      );
    } finally {
      setPublicBusy(false);
    }
  };

  const disablePublic = async () => {
    setPublicBusy(true);
    try {
      await authManager.api.revokePublicLink(docId);
      setExisting(null);
      setFallbackUrl(null);
      toast("Public link disabled — the old link no longer works");
    } catch (e) {
      toast(
        e instanceof ApiError ? e.message : "Couldn't disable the public link",
        "error",
      );
    } finally {
      setPublicBusy(false);
    }
  };

  return (
    <div className="share-menu" ref={rootRef}>
      <button
        className={`icon-btn share-btn${copied ? " copied" : ""}${open ? " active" : ""}`}
        title="Copy a link to this note"
        aria-label="Copy a link to this note"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {copied ? (
          <CheckMark size="sm" />
        ) : (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="18" cy="5" r="3" />
            <circle cx="6" cy="12" r="3" />
            <circle cx="18" cy="19" r="3" />
            <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
          </svg>
        )}
      </button>
      {open && (
        <div className="account-popover share-popover" role="menu">
          <button className="menu-item" onClick={() => void copyPrivate()}>
            <span className="menu-item-label">Copy private link</span>
            <span className="menu-hint">Team members with access</span>
          </button>
          <button
            className="menu-item"
            disabled={publicBusy}
            onClick={() => void copyPublic()}
          >
            <span className="menu-item-label">Copy public link</span>
            {publicBusy ? (
              <Spinner size="xs" />
            ) : (
              <span className="menu-hint">Anyone with the link can view</span>
            )}
          </button>
          {fallbackUrl && (
            <button
              className="menu-item share-fallback-url"
              title="Copy the public link"
              onClick={() => {
                void copyText(fallbackUrl).then((ok) => {
                  if (ok) {
                    setFallbackCopied(true);
                    toast("Public link copied — anyone with this link can view this note");
                  } else {
                    toast("Couldn't copy the link", "error");
                  }
                });
              }}
            >
              <span className="menu-item-label">{fallbackUrl}</span>
              {fallbackCopied ? <CheckMark size="xs" /> : <span className="menu-hint">Copy</span>}
            </button>
          )}
          {existing !== null && existing !== "loading" && (
            <>
              <div className="menu-sep" />
              <button
                className="menu-item danger"
                disabled={publicBusy}
                onClick={() => void disablePublic()}
              >
                <span className="menu-item-label">Disable public link</span>
                <span className="menu-hint">The link stops working</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
