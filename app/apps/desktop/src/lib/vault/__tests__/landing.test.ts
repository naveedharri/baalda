import { describe, expect, it } from "vitest";
import { planLanding, type LandingInput } from "../landing";

// Signing in must always end somewhere. The bug this suite pins was the absence
// of the last two branches: a first sign-in holding two or more vaults, and an
// account holding none, both fell through to "do nothing" — which renders as the
// signed-out welcome screen, so signing in looked like it had failed.

const base: LandingInput = {
  orgIds: [],
  requestedOrgId: null,
  openPath: null,
  orgVaults: {},
  activeOrganizationId: null,
  rememberedOrgId: null,
  createIfNone: false,
};
const plan = (over: Partial<LandingInput>) => planLanding({ ...base, ...over });

describe("planLanding — an explicit request wins", () => {
  it("switches to the vault the user clicked before signing in", () => {
    expect(
      plan({
        orgIds: ["a", "b"],
        requestedOrgId: "b",
        // Even with a synced folder open and a different vault active.
        openPath: "/v/a",
        orgVaults: { a: "/v/a" },
        activeOrganizationId: "a",
      }),
    ).toEqual({ kind: "switch", orgId: "b" });
  });

  it("ignores a request for a vault we are not a member of", () => {
    // Removed from the vault between clicking it and finishing sign-in.
    expect(plan({ orgIds: ["a"], requestedOrgId: "gone" })).toEqual({
      kind: "switch",
      orgId: "a",
    });
  });
});

describe("planLanding — a folder is already open", () => {
  it("just enables sync when the open folder is the active vault's", () => {
    expect(
      plan({
        orgIds: ["a"],
        openPath: "/v/a",
        orgVaults: { a: "/v/a" },
        activeOrganizationId: "a",
      }),
    ).toEqual({ kind: "enable-sync" });
  });

  it("switches when the open folder belongs to a DIFFERENT vault", () => {
    expect(
      plan({
        orgIds: ["a", "b"],
        openPath: "/v/b",
        orgVaults: { a: "/v/a", b: "/v/b" },
        activeOrganizationId: "a",
      }),
    ).toEqual({ kind: "switch", orgId: "b" });
  });

  it("keeps a local-only folder local rather than pulling the user elsewhere", () => {
    // The whole point of a local-first app: being signed in must not relocate
    // you. "Turn on sync" is the affordance for adopting this folder.
    expect(
      plan({
        orgIds: ["a", "b"],
        openPath: "/somewhere/local",
        orgVaults: { a: "/v/a" },
        activeOrganizationId: "a",
        rememberedOrgId: "b",
        createIfNone: true,
      }),
    ).toEqual({ kind: "stay-local" });
  });

  it("leaves a folder bound to a vault we've been removed from, for one we still have", () => {
    // Not "stay-local": that binding is dead and can never sync again, so the
    // restore chain gets to pick a vault the user actually still has.
    expect(
      plan({ orgIds: ["b"], openPath: "/v/a", orgVaults: { a: "/v/a" } }),
    ).toEqual({ kind: "switch", orgId: "b" });
  });
});

describe("planLanding — nothing open", () => {
  it("restores the session's active vault", () => {
    expect(
      plan({ orgIds: ["a", "b"], activeOrganizationId: "b", rememberedOrgId: "a" }),
    ).toEqual({ kind: "switch", orgId: "b" });
  });

  it("falls back to the last vault used on this device", () => {
    expect(plan({ orgIds: ["a", "b"], rememberedOrgId: "b" })).toEqual({
      kind: "switch",
      orgId: "b",
    });
  });

  it("ignores an active or remembered vault we are no longer a member of", () => {
    expect(
      plan({ orgIds: ["a"], activeOrganizationId: "gone", rememberedOrgId: "alsogone" }),
    ).toEqual({ kind: "switch", orgId: "a" });
  });

  // The regression. Better Auth keeps `activeOrganizationId` on the SESSION row,
  // so a first sign-in on a device starts null; with 2+ vaults the store's
  // single-vault auto-activation doesn't fire either. Both prior signals are
  // therefore empty in the most ordinary case there is, and the old code
  // returned without doing anything.
  it("opens the first vault on a first sign-in with several vaults", () => {
    expect(plan({ orgIds: ["a", "b", "c"] })).toEqual({ kind: "switch", orgId: "a" });
  });

  it("opens the only vault on a first sign-in with one", () => {
    expect(plan({ orgIds: ["solo"] })).toEqual({ kind: "switch", orgId: "solo" });
  });
});

describe("planLanding — an account with no vaults", () => {
  it("creates the first vault when the caller allows it", () => {
    expect(plan({ createIfNone: true })).toEqual({ kind: "create-first-vault" });
  });

  it("does nothing on a silent session restore at launch", () => {
    // `createIfNone` is false there on purpose: "I just signed in" earns a
    // vault, "the app reopened" does not.
    expect(plan({ createIfNone: false })).toEqual({ kind: "nothing" });
  });

  it("never creates a vault while a local folder is open", () => {
    expect(plan({ openPath: "/somewhere/local", createIfNone: true })).toEqual({
      kind: "stay-local",
    });
  });

  it("never creates a vault while a folder with a dead binding is open", () => {
    // Falls through the restore chain with no vault to restore. Creating one
    // here would swap out the files the user is looking at.
    expect(
      plan({ openPath: "/v/gone", orgVaults: { gone: "/v/gone" }, createIfNone: true }),
    ).toEqual({ kind: "nothing" });
  });

  it("never creates a vault when the user asked for one they're a member of", () => {
    expect(
      plan({ orgIds: ["a"], requestedOrgId: "a", createIfNone: true }),
    ).toEqual({ kind: "switch", orgId: "a" });
  });
});

// "Join a team" on the welcome screen runs sign-in/sign-up FIRST and then comes
// back for the code, so the auth that just happened must not land the user
// anywhere. Every case below would otherwise unmount the screen still holding
// the flow — most damagingly the brand-new account, which is exactly who this
// route is for and who would be handed an auto-created "My Vault" instead.
describe("planLanding — mid join-with-code", () => {
  it("does nothing for a brand-new account that would otherwise get one made", () => {
    expect(plan({ joiningWithCode: true, createIfNone: true })).toEqual({
      kind: "nothing",
    });
  });

  it("does nothing for an existing account with vaults to restore", () => {
    expect(
      plan({
        joiningWithCode: true,
        orgIds: ["a", "b"],
        activeOrganizationId: "a",
        rememberedOrgId: "b",
        createIfNone: true,
      }),
    ).toEqual({ kind: "nothing" });
  });

  it("outranks even an explicit open-this-vault request", () => {
    expect(
      plan({ joiningWithCode: true, orgIds: ["a"], requestedOrgId: "a" }),
    ).toEqual({ kind: "nothing" });
  });
});
