import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../api";
import {
  acceptInviteFailureMessage,
  clearPendingInvite,
  INVITE_GONE_MESSAGE,
  peekPendingInvite,
  queueInvite,
  takePendingInvite,
} from "../inviteFlow";

/**
 * The invite flow's pure parts (#99).
 *
 * The queue is a handoff between two moments of one flow (link arrives →
 * session exists), and the message mapping is the difference between an
 * invitation failing usefully and failing with Better Auth's raw wording, which
 * names neither address involved.
 */
describe("pending invite queue", () => {
  beforeEach(() => clearPendingInvite());

  it("hands back what was queued, exactly once", () => {
    queueInvite({ invitationId: "inv_1", server: null });
    expect(peekPendingInvite()).toEqual({ invitationId: "inv_1", server: null });
    // Peeking must not consume — the landing skip reads it and acceptance eats it.
    expect(takePendingInvite()).toEqual({ invitationId: "inv_1", server: null });
    expect(takePendingInvite()).toBeNull();
  });

  it("keeps only the latest — two clicks means the second one matters", () => {
    queueInvite({ invitationId: "inv_1", server: null });
    queueInvite({ invitationId: "inv_2", server: "https://notes.example.com" });
    expect(takePendingInvite()).toEqual({
      invitationId: "inv_2",
      server: "https://notes.example.com",
    });
  });

  it("clears without consuming into a caller", () => {
    queueInvite({ invitationId: "inv_1", server: null });
    clearPendingInvite();
    expect(peekPendingInvite()).toBeNull();
  });
});

describe("acceptInviteFailureMessage", () => {
  it("names both addresses on a recipient mismatch", () => {
    const msg = acceptInviteFailureMessage(
      new Error("You are not the recipient of the invitation"),
      { inviteEmail: "ada@team.com", sessionEmail: "me@personal.com" },
    );
    expect(msg).toBe(
      "This invitation was sent to ada@team.com, but you're signed in as me@personal.com. " +
        "Sign out and sign in with ada@team.com, or ask your admin to invite me@personal.com instead.",
    );
  });

  it("stays vague rather than naming a wrong address when one is unknown", () => {
    const msg = acceptInviteFailureMessage(
      new Error("You are not the recipient of the invitation"),
      { inviteEmail: null, sessionEmail: "me@personal.com" },
    );
    expect(msg).toContain("a different email address");
    expect(msg).not.toContain("null");
  });

  it("merges expired / used / revoked into one honest sentence", () => {
    expect(
      acceptInviteFailureMessage(new Error("Invitation not found"), {
        inviteEmail: "ada@team.com",
        sessionEmail: "ada@team.com",
      }),
    ).toBe(INVITE_GONE_MESSAGE);
  });

  it("keeps an unrecognised server message instead of inventing friendlier copy", () => {
    expect(
      acceptInviteFailureMessage(new Error("Organization member limit reached"), {
        inviteEmail: "ada@team.com",
        sessionEmail: "ada@team.com",
      }),
    ).toBe("Organization member limit reached");
  });

  it("survives a thrown non-Error", () => {
    expect(
      acceptInviteFailureMessage("Invitation not found", {
        inviteEmail: null,
        sessionEmail: null,
      }),
    ).toBe(INVITE_GONE_MESSAGE);
    expect(
      acceptInviteFailureMessage(undefined, { inviteEmail: null, sessionEmail: null }),
    ).toBe(INVITE_GONE_MESSAGE);
  });
});

describe("acceptInviteFailureMessage: people limits at acceptance", () => {
  const ctx = { inviteEmail: "a@x.com", sessionEmail: "a@x.com" };
  it("a full Team vault tells the invitee whom to ask", () => {
    const e = new ApiError(402, "All 5 seats are in use.", { error: "seat_limit_reached", seats: 5, used: 5, pending: 0 });
    expect(acceptInviteFailureMessage(e, ctx)).toBe(
      "All 5 seats are in use. Ask the person who invited you to add a seat, then accept again.",
    );
  });
  it("a full Free vault uses the account's own limit", () => {
    const e = new ApiError(402, "member_limit_reached", { error: "member_limit_reached", limit: 3, scope: "account" });
    expect(acceptInviteFailureMessage(e, ctx)).toBe(
      "Free includes 3 people. This vault is full. Ask the person who invited you to upgrade to Team, then accept again.",
    );
  });
  it("a lapsed account says it cannot take new people", () => {
    const e = new ApiError(402, "x", { error: "account_read_only" });
    expect(acceptInviteFailureMessage(e, ctx)).toMatch(/can't take new people/);
  });
});
