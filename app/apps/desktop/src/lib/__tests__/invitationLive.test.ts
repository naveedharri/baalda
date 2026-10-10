import { describe, expect, it } from "vitest";
import {
  invitationFrameAction,
  needsInvitationPoll,
  notifyInvitationFrame,
  setInvitationFrameHandler,
  type InvitationFrame,
} from "../invitationLive";
import { parseServerControl } from "../sync/vaultProtocol";

describe("invitationFrameAction", () => {
  it("refreshes on an arrival and drops on a gone frame", () => {
    expect(
      invitationFrameAction({
        t: "invitation",
        invitationId: "inv-1",
      }),
    ).toEqual({ kind: "refresh" });
    expect(invitationFrameAction({ t: "invitation-gone", invitationId: "inv-1" })).toEqual({
      kind: "drop",
      invitationId: "inv-1",
    });
  });

  it("ignores other frames and frames without an id", () => {
    expect(invitationFrameAction({ t: "member" })).toBeNull();
    expect(invitationFrameAction({ t: "invitation" })).toBeNull();
    expect(invitationFrameAction({ t: "invitation-gone", invitationId: "" })).toBeNull();
  });
});

describe("invitation frames on the wire", () => {
  it("parses both frames from the vault channel", () => {
    expect(
      parseServerControl(
        JSON.stringify({
          t: "invitation",
          invitationId: "inv-1",
          orgId: "org-b",
          orgName: "Design",
          inviterName: "Sam",
          role: "admin",
        }),
      ),
    ).toEqual({
      t: "invitation",
      invitationId: "inv-1",
      orgId: "org-b",
      orgName: "Design",
      inviterName: "Sam",
      role: "admin",
    });
    expect(parseServerControl(JSON.stringify({ t: "invitation-gone", invitationId: "x" }))).toEqual({
      t: "invitation-gone",
      invitationId: "x",
    });
    expect(parseServerControl(JSON.stringify({ t: "invitation" }))).toBeNull();
  });

  it("relays frames to the registered handler only", () => {
    const got: InvitationFrame[] = [];
    notifyInvitationFrame({ t: "invitation-gone", invitationId: "early" }); // no handler: dropped
    setInvitationFrameHandler((f) => got.push(f));
    notifyInvitationFrame({ t: "invitation-gone", invitationId: "a" });
    setInvitationFrameHandler(null);
    notifyInvitationFrame({ t: "invitation-gone", invitationId: "late" });
    expect(got).toEqual([{ t: "invitation-gone", invitationId: "a" }]);
  });
});

describe("needsInvitationPoll", () => {
  it("polls only while no vault channel is live", () => {
    expect(needsInvitationPoll("synced")).toBe(false);
    expect(needsInvitationPoll("read-only")).toBe(false);
    expect(needsInvitationPoll("offline")).toBe(true);
    expect(needsInvitationPoll("connecting")).toBe(true);
    expect(needsInvitationPoll("error")).toBe(true);
  });
});
