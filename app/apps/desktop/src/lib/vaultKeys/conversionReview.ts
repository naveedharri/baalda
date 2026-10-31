// The owner's review at conversion (pure, for tests).
//
// Before an owner/admin device allow-lists the existing MCP tokens,
// Claude/ChatGPT connections and public links of a vault it converts, the
// person sees each one (all checked) and may uncheck any. An unchecked one is
// sent as `excluded`: the server never allow-lists it, stops waiting for it
// at the conversion gate, and revokes nothing (it works until the vault is
// keyed, then needs reconnecting).

import type { AllowlistCandidate } from "../api";

/** Stable identity of a candidate across polls. */
export const candidateKey = (c: { kind: string; id: string }) => `${c.kind}:${c.id}`;

export function kindLabel(kind: string): string {
  switch (kind) {
    case "mcp_token":
    case "token":
      return "MCP token";
    case "oauth_grant":
      return "Claude/ChatGPT connection";
    case "public_link":
    case "link":
      return "Public link";
    default:
      return "Connection";
  }
}

/** The row's title: its own name, else what it is. */
export function candidateTitle(c: AllowlistCandidate): string {
  const label = typeof c.label === "string" ? c.label.trim() : "";
  return label || kindLabel(c.kind);
}

/** "MCP token · created by Sara · last used 3d ago" (`when` formats an ISO time). */
export function candidateDetail(c: AllowlistCandidate, when: (iso: string) => string): string {
  const parts = [kindLabel(c.kind)];
  if (c.createdBy) parts.push(`created by ${c.createdBy}`);
  parts.push(c.lastUsedAt ? `last used ${when(c.lastUsedAt)}` : "never used");
  return parts.join(" · ");
}

export const REVIEW_TITLE = "Keep these connections working?";
export const REVIEW_INTRO =
  "Encrypting this vault gives each connection below its own copy of the key. Uncheck anything you don't recognise or no longer use.";
export const REVIEW_UNCHECKED_NOTE =
  "Unchecked connections keep working until encryption finishes, then stop and need to be reconnected.";

export type ReviewSplit = {
  /** Allow-list (MACs posted every poll: refresh tokens rotate). */
  keep: AllowlistCandidate[];
  /** Send as `excluded` (not yet recorded by the server). */
  exclude: AllowlistCandidate[];
  /** Nobody decided yet: the review must be shown before conversion. */
  undecided: AllowlistCandidate[];
};

/**
 * Sort candidates by who decided what. This device's answers in this session
 * win; then the server's record (`excluded` / `allowed`, from an earlier review
 * on any device). Without review support (`reviewing: false`, an older flow)
 * everything not excluded is kept, as before.
 */
export function splitForReview(
  candidates: AllowlistCandidate[],
  decisions: ReadonlyMap<string, boolean> | undefined,
  reviewing: boolean,
): ReviewSplit {
  const out: ReviewSplit = { keep: [], exclude: [], undecided: [] };
  for (const c of candidates) {
    const mine = decisions?.get(candidateKey(c));
    if (mine === true) out.keep.push(c);
    else if (mine === false) {
      if (!c.excluded) out.exclude.push(c);
    } else if (c.excluded) continue;
    else if (c.allowed || !reviewing) out.keep.push(c);
    else out.undecided.push(c);
  }
  return out;
}
