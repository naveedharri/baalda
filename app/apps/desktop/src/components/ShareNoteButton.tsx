import { useEffect, useState } from "react";
import { buildNoteLink } from "../lib/shareLink";
import { toast } from "../lib/toast";
import { useStore } from "../store";
import { CheckMark } from "./Spinner";

/**
 * "Copy link to this note" — the header's share affordance.
 *
 * One click, one clipboard write, no dialog: the thing people actually want is
 * a link they can paste into chat, and every extra step between the note and
 * the paste is a step where they give up and describe the note in words
 * instead. Permissions already have a home (Access), so this button
 * deliberately does not try to be a second one.
 *
 * The link carries a vault id and a doc_id and nothing else — opening it
 * resolves both against whoever clicks, so sending it to someone without a
 * grant hands them nothing.
 */
export function ShareNoteButton({ docId }: { docId: string }) {
  const orgId = useStore((s) => s.session?.activeOrganizationId ?? null);
  const [copied, setCopied] = useState(false);

  // The tick is a state, so it has to be cleared — otherwise switching notes
  // leaves a stale "copied" on a link nobody copied.
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(id);
  }, [copied]);
  useEffect(() => setCopied(false), [docId]);

  if (!orgId) return null;

  const copy = async () => {
    const link = buildNoteLink({ orgId, docId });
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      toast("Link copied — anyone on your team with access can open it");
    } catch {
      toast("Couldn't copy the link", "error");
    }
  };

  return (
    <button
      className={`icon-btn share-btn${copied ? " copied" : ""}`}
      title="Copy a link to this note"
      aria-label="Copy a link to this note"
      onClick={() => void copy()}
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
  );
}
