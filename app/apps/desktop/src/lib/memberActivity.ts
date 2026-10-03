// SPDX-License-Identifier: Apache-2.0
// The member profile's Activity timeline, as pure data: day groups, collapsed
// runs of edits/creates, and the one-line summary. The component only renders.

import type { MemberActivityEvent, MemberRef } from "./api";
import { shortDate, splitNotePath } from "./membersAccess";

type NoteEvent = Extract<MemberActivityEvent, { kind: "created" | "edited" }>;

/** A run of more than this many same-kind note events in one day collapses. */
export const COLLAPSE_OVER = 3;

export type TimelineEntry =
  | { type: "event"; event: MemberActivityEvent; origin: boolean }
  | { type: "run"; kind: "created" | "edited"; events: NoteEvent[] };

export interface TimelineDay {
  key: string;
  label: string;
  entries: TimelineEntry[];
}

const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** "Today", "Yesterday", else the short date ("Oct 2"). */
export function dayLabel(dayStart: number, now: number): string {
  const today = startOfDay(now);
  if (dayStart >= today) return "Today";
  if (dayStart >= startOfDay(today - 1)) return "Yesterday";
  return shortDate(new Date(dayStart).toISOString());
}

/**
 * Newest first, grouped by calendar day. Within a day, more than
 * {@link COLLAPSE_OVER} consecutive `edited` (or `created`) events become one
 * run; access changes and the join never collapse. When the list holds no
 * `joined` event but the join date is known, one is added as the origin.
 */
export function buildTimeline(
  events: readonly MemberActivityEvent[],
  now: number,
  join?: { at: string | null; invitedBy: MemberRef | null },
): TimelineDay[] {
  const sorted = events
    .filter((e) => Number.isFinite(Date.parse(e.at)))
    .slice()
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  if (!sorted.some((e) => e.kind === "joined") && join?.at && Number.isFinite(Date.parse(join.at))) {
    sorted.push({ kind: "joined", at: join.at, invitedBy: join.invitedBy });
  }
  const days: TimelineDay[] = [];
  for (const event of sorted) {
    const start = startOfDay(Date.parse(event.at));
    let day = days[days.length - 1];
    if (!day || day.key !== String(start)) {
      day = { key: String(start), label: dayLabel(start, now), entries: [] };
      days.push(day);
    }
    day.entries.push({ type: "event", event, origin: event.kind === "joined" });
  }
  for (const day of days) day.entries = collapseRuns(day.entries);
  return days;
}

function collapseRuns(entries: TimelineEntry[]): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  let i = 0;
  while (i < entries.length) {
    const first = entries[i];
    const kind = first.type === "event" ? first.event.kind : null;
    if (kind !== "edited" && kind !== "created") {
      out.push(first);
      i++;
      continue;
    }
    let j = i;
    const run: NoteEvent[] = [];
    while (j < entries.length) {
      const e = entries[j];
      if (e.type !== "event" || e.event.kind !== kind) break;
      run.push(e.event as NoteEvent);
      j++;
    }
    if (run.length > COLLAPSE_OVER) out.push({ type: "run", kind, events: run });
    else out.push(...entries.slice(i, j));
    i = j;
  }
  return out;
}

/** "Welcome, AGENTS, Keyboard shortcuts and 6 more" — distinct note names, newest first. */
export function runNames(events: readonly NoteEvent[], shown = 3): string {
  const names = [...new Set(events.map((e) => splitNotePath(e.path).name))];
  if (names.length <= shown) {
    return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }
  return `${names.slice(0, shown).join(", ")} and ${names.length - shown} more`;
}

/** The folder every note in the run lives in ("Getting Started"), or null when they differ. */
export function commonFolder(events: readonly NoteEvent[]): string | null {
  const parents = new Set(events.map((e) => splitNotePath(e.path).folders.join(" › ")));
  if (parents.size !== 1) return null;
  const only = [...parents][0];
  return only || null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * "Active for 23 days · 42 edits · 3 notes created", counting only the loaded
 * events; "… in the last 50 events" when the list hit its cap.
 */
export function activitySummary(
  events: readonly MemberActivityEvent[],
  joinedAt: string | null,
  now: number,
  limit: number,
): string {
  const joinedIso = joinedAt ?? events.find((e) => e.kind === "joined")?.at ?? null;
  const parts: string[] = [];
  const joined = joinedIso ? Date.parse(joinedIso) : NaN;
  if (Number.isFinite(joined)) {
    const days = Math.max(0, Math.round((startOfDay(now) - startOfDay(joined)) / 86_400_000));
    parts.push(days === 0 ? "Joined today" : `Active for ${plural(days, "day", "days")}`);
  }
  const edits = events.filter((e) => e.kind === "edited").length;
  const created = events.filter((e) => e.kind === "created").length;
  if (edits) parts.push(plural(edits, "edit", "edits"));
  if (created) parts.push(`${plural(created, "note", "notes")} created`);
  const line = parts.join(" · ");
  return line && events.length >= limit ? `${line} in the last ${limit} events` : line;
}
