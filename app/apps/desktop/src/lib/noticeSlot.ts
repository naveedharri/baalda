/**
 * The ONE notice slot above the editor.
 *
 * Every top banner in the editor column used to render on its own, so a
 * reconnect could stack three of them at once (a held bulk delete, the
 * reconcile summary and "your access to this note was removed"). Now each one
 * says it WANTS the slot and only the highest-priority wanting notice shows; when
 * it goes (dismissed, faded or no longer true) the next one in line shows.
 *
 * Nothing shown here is the only record: reconcile items stay in Activity
 * ("Review changes (N)"), access removals are in Activity's access events, and
 * a held bulk delete is listed in Activity and Health until it is released.
 */

/** How long an informational notice stays before it fades by itself. */
export const NOTICE_FADE_MS = 20_000;

/**
 * Highest first. The first three are the ones that collided; the rest keep the
 * order they had in the column. Notices with a pending choice (sign in, locate
 * the folder, upgrade, close the gone note) never fade; see each call site.
 */
export const NOTICE_PRIORITY = [
  "held-delete",
  "reconcile",
  "note-removed",
  "vault-unsynced",
  "membership-lost",
  "root-missing",
  // A missing folder inside the vaults root was recreated (informational).
  "root-restored",
  "account-lapsed",
  "closed-app-changes",
  "not-syncing",
  "sync-paused",
  "note-limit",
  "create-refusal",
  "removed-on-disk",
  "attachment-local-only",
] as const;

export type NoticeId = (typeof NOTICE_PRIORITY)[number];

/** The notice that gets the slot: the highest-priority one that wants it. */
export function pickNotice(wanted: ReadonlySet<NoticeId>): NoticeId | null {
  for (const id of NOTICE_PRIORITY) if (wanted.has(id)) return id;
  return null;
}

const wanted = new Set<NoticeId>();
const listeners = new Set<() => void>();
let top: NoticeId | null = null;

function recompute(): void {
  const next = pickNotice(wanted);
  if (next === top) return;
  top = next;
  for (const l of [...listeners]) l();
}

/** A notice starts or stops wanting the slot. */
export function setNoticeWanted(id: NoticeId, on: boolean): void {
  if (on === wanted.has(id)) return;
  if (on) wanted.add(id);
  else wanted.delete(id);
  recompute();
}

/** The notice currently holding the slot. */
export function currentNotice(): NoticeId | null {
  return top;
}

export function subscribeNotice(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tests only: forget every claim. */
export function resetNoticeSlot(): void {
  wanted.clear();
  top = null;
  for (const l of [...listeners]) l();
}
