import { describe, expect, it } from "vitest";
import {
  READ_STATE_MAX,
  badgeText,
  freshReadState,
  markAllRead,
  parseReadState,
  unreadCount,
  unreadRows,
} from "../activityUnread";

const T = 1_000_000;
const row = (key: string, at: number) => ({ key, at });

describe("activity unread", () => {
  it("treats rows older than the state's start as read", () => {
    const s = freshReadState(T);
    expect(unreadCount([row("a", T - 1), row("b", T), row("c", T + 1)], s)).toBe(1);
  });

  it("counts a late-arriving row that is newer than the start", () => {
    const s = markAllRead(freshReadState(T), [row("a", T + 5)]);
    expect(unreadRows([row("a", T + 5), row("late", T + 2)], s).map((r) => r.key)).toEqual(["late"]);
  });

  it("marks everything read, and returns the same state when nothing is new", () => {
    const s0 = freshReadState(T);
    const rows = [row("a", T + 1), row("b", T + 2)];
    const s1 = markAllRead(s0, rows);
    expect(unreadCount(rows, s1)).toBe(0);
    expect(markAllRead(s1, rows)).toBe(s1);
    expect(s1.since).toBe(T);
  });

  it("keys by id AND time: the same row at a new time is new again", () => {
    const s = markAllRead(freshReadState(T), [row("t:d1", T + 1)]);
    expect(unreadCount([row("t:d1", T + 9)], s)).toBe(1);
  });

  it("caps the read list, newest kept", () => {
    const rows = Array.from({ length: READ_STATE_MAX + 5 }, (_, i) => row(`r${i}`, T + 1 + i));
    const s = markAllRead(freshReadState(T), rows);
    expect(s.read).toHaveLength(READ_STATE_MAX);
    expect(s.read[0]).toBe(`r${READ_STATE_MAX + 4}@${T + READ_STATE_MAX + 5}`);
  });

  it("formats the badge", () => {
    expect(badgeText(0)).toBe("");
    expect(badgeText(7)).toBe("7");
    expect(badgeText(99)).toBe("99");
    expect(badgeText(100)).toBe("99+");
  });

  it("parses stored state defensively", () => {
    expect(parseReadState(null)).toBeNull();
    expect(parseReadState("x")).toBeNull();
    expect(parseReadState('{"since":"no"}')).toBeNull();
    expect(parseReadState(JSON.stringify({ since: 5, read: ["a@1", 3] }))).toEqual({ since: 5, read: ["a@1"] });
  });
});
