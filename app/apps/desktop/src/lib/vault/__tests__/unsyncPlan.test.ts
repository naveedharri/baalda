// The one decision the "vault was made local only" banner rests on.
//
// Getting it wrong in either direction is expensive: too eager and a teammate's
// folder gets offered up for adoption into the wrong account; too shy and a
// folder whose vault really is gone stays permanently unsyncable, which is the
// dead end the feature exists to remove.

import { describe, expect, it } from "vitest";
import { planUnsyncStamp } from "../unsyncPlan";

describe("planUnsyncStamp", () => {
  it("says nothing about a folder that was never synced", () => {
    expect(
      planUnsyncStamp({ stampedOrgId: null, knownOrgIds: [], statusAnswer: "unknown" }),
    ).toBe("ok");
  });

  it("says nothing about a folder whose vault we are a member of", () => {
    // The cheap local answer — this is what keeps the probe off the launch path
    // for every healthy vault, so the status answer is not even consulted.
    expect(
      planUnsyncStamp({
        stampedOrgId: "org-a",
        knownOrgIds: ["org-a", "org-b"],
        statusAnswer: "unknown",
      }),
    ).toBe("ok");
  });

  it("reads a 404 as 'this vault was made local only'", () => {
    expect(
      planUnsyncStamp({
        stampedOrgId: "org-dead",
        knownOrgIds: [],
        statusAnswer: "vault-not-found",
      }),
    ).toBe("local-only");
  });

  it("reads a 403 as someone else's folder — today's refusal stands", () => {
    expect(
      planUnsyncStamp({
        stampedOrgId: "org-theirs",
        knownOrgIds: [],
        statusAnswer: "not-a-member",
      }),
    ).toBe("foreign");
  });

  it("fails closed on a network error: no verdict, no banner", () => {
    // A vault that merely could not be reached must NOT be told it was deleted.
    expect(
      planUnsyncStamp({
        stampedOrgId: "org-a",
        knownOrgIds: [],
        statusAnswer: "unknown",
      }),
    ).toBe("unknown");
  });

  it("believes the server over a stale vault list", () => {
    // `organizations` had not refreshed yet; the server says we are a member,
    // and the server is the authority.
    expect(
      planUnsyncStamp({
        stampedOrgId: "org-a",
        knownOrgIds: [],
        statusAnswer: "member",
      }),
    ).toBe("ok");
  });

  it("treats a stamp that contradicts the profile's binding as a mismatch, not a gone vault", () => {
    // The folder was synced against another server (say production); this
    // profile binds it to a vault on THIS server. This server 404s the
    // production id, which must not read as "made local only".
    expect(
      planUnsyncStamp({
        stampedOrgId: "org-prod",
        knownOrgIds: ["org-local"],
        statusAnswer: "vault-not-found",
        boundOrgId: "org-local",
      }),
    ).toBe("foreign");
  });

  it("answers a mismatch locally, without needing the status probe", () => {
    expect(
      planUnsyncStamp({
        stampedOrgId: "org-prod",
        knownOrgIds: ["org-local"],
        statusAnswer: "unknown",
        boundOrgId: "org-local",
      }),
    ).toBe("foreign");
  });

  it("still reads a 404 as gone when the binding names the stamped vault itself", () => {
    // The real other-device unsync: the binding still points at the dead vault.
    expect(
      planUnsyncStamp({
        stampedOrgId: "org-dead",
        knownOrgIds: ["org-b"],
        statusAnswer: "vault-not-found",
        boundOrgId: "org-dead",
      }),
    ).toBe("local-only");
  });

  it("ignores a binding to a vault we are no longer in", () => {
    expect(
      planUnsyncStamp({
        stampedOrgId: "org-dead",
        knownOrgIds: [],
        statusAnswer: "vault-not-found",
        boundOrgId: "org-removed",
      }),
    ).toBe("local-only");
  });
});
