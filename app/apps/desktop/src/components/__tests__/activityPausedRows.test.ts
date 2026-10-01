import { describe, expect, it } from "vitest";
import type { ShrinkBrakeEvent } from "../../lib/api";
import { buildActivity, failureEntries, pausedText } from "../activityRows";

// Owners/admins see "sync paused for <member>" in Activity, and only a live
// pause offers Release (#252).

const T = Date.parse("2026-09-26T10:00:00.000Z");

function event(over: Partial<ShrinkBrakeEvent> = {}): ShrinkBrakeEvent {
  return {
    id: "e1",
    userId: "u-member",
    userName: "Sam",
    noteCount: 12,
    engagedAt: new Date(T).toISOString(),
    heldUntil: new Date(T + 30 * 60_000).toISOString(),
    releasedAt: null,
    releasedBy: null,
    held: true,
    ...over,
  };
}

describe("paused rows", () => {
  it("names the member, how many notes and when, and offers Release to a manager", () => {
    const rows = buildActivity({
      reconcile: [],
      trash: [],
      copies: [],
      brakes: { items: [event()], canRelease: true, selfId: "u-owner" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "paused",
      key: "p:e1",
      at: T,
      label: "Paused",
      canRelease: true,
      own: false,
      text: "Sync paused for Sam · 12 notes emptied at once",
    });
  });

  it("never offers Release on a pause that already ended, nor to a non-manager", () => {
    const ended = buildActivity({
      reconcile: [],
      trash: [],
      copies: [],
      brakes: { items: [event({ held: false, releasedAt: new Date(T + 1).toISOString() })], canRelease: true, selfId: null },
    });
    expect(ended[0]).toMatchObject({ label: "Resumed", canRelease: false });
    const member = buildActivity({
      reconcile: [],
      trash: [],
      copies: [],
      brakes: { items: [event({ userId: "me" })], canRelease: false, selfId: "me" },
    });
    expect(member[0]).toMatchObject({ canRelease: false, own: true, text: "Your sync was paused · 12 notes emptied at once" });
  });

  it("falls back to 'a member' without a name", () => {
    expect(pausedText({ userName: null, noteCount: 1 }, false)).toBe("Sync paused for a member · 1 note emptied at once");
    expect(pausedText({ userName: "  ", noteCount: 2 }, false)).toBe("Sync paused for a member · 2 notes emptied at once");
  });

  it("does not list each held note as a failure", () => {
    const entries = failureEntries({
      registry: [],
      content: [
        { docId: "a", relPath: "a.md", reason: "Sync paused", kind: "shrink-held" },
        { docId: "b", relPath: "b.md", reason: "network" },
      ],
      limitCode: null,
    });
    expect(entries.map((e) => e.docId)).toEqual(["b"]);
  });
});
