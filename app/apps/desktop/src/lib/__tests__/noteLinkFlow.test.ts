import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPendingNoteLink,
  hasPendingNoteLink,
  keepWaitingForDoc,
  openNoteFailureMessage,
  peekPendingNoteLink,
  queueNoteLink,
  takePendingNoteLink,
} from "../noteLinkFlow";

describe("pending note-link queue", () => {
  beforeEach(() => clearPendingNoteLink());

  it("take returns the queued link once and clears it", () => {
    queueNoteLink("baalda://note/o/d");
    expect(hasPendingNoteLink()).toBe(true);
    expect(takePendingNoteLink()).toBe("baalda://note/o/d");
    expect(takePendingNoteLink()).toBeNull();
    expect(hasPendingNoteLink()).toBe(false);
  });

  it("keeps only the LATEST link — the second click supersedes the first", () => {
    queueNoteLink("baalda://note/o/first");
    queueNoteLink("baalda://note/o/second");
    expect(takePendingNoteLink()).toBe("baalda://note/o/second");
  });

  it("peek reads without consuming; clear empties", () => {
    queueNoteLink("baalda://note/o/d");
    expect(peekPendingNoteLink()).toBe("baalda://note/o/d");
    expect(hasPendingNoteLink()).toBe(true);
    clearPendingNoteLink();
    expect(peekPendingNoteLink()).toBeNull();
  });
});

describe("keepWaitingForDoc", () => {
  const base = { baseMs: 20_000, capMs: 90_000 };

  it("always waits inside the base window, busy or not", () => {
    expect(keepWaitingForDoc({ ...base, elapsedMs: 0, busy: false })).toBe(true);
    expect(keepWaitingForDoc({ ...base, elapsedMs: 19_999, busy: false })).toBe(true);
  });

  it("past the base window: keeps waiting only while sync is busy", () => {
    expect(keepWaitingForDoc({ ...base, elapsedMs: 20_000, busy: false })).toBe(false);
    expect(keepWaitingForDoc({ ...base, elapsedMs: 20_000, busy: true })).toBe(true);
    expect(keepWaitingForDoc({ ...base, elapsedMs: 89_999, busy: true })).toBe(true);
  });

  it("never waits past the cap, even while busy", () => {
    expect(keepWaitingForDoc({ ...base, elapsedMs: 90_000, busy: true })).toBe(false);
  });
});

describe("openNoteFailureMessage", () => {
  it("names connectivity when sync is on but unreachable (membership already verified)", () => {
    for (const syncStatus of ["offline", "connecting", "error"]) {
      expect(openNoteFailureMessage({ syncEnabled: true, syncStatus })).toContain(
        "Couldn't reach the server",
      );
    }
  });

  it("keeps the EXACT generic anti-enumeration text otherwise", () => {
    const generic = "Couldn't open that note — you may not have access to it";
    expect(openNoteFailureMessage({ syncEnabled: true, syncStatus: "synced" })).toBe(generic);
    expect(openNoteFailureMessage({ syncEnabled: false, syncStatus: "offline" })).toBe(generic);
  });
});
