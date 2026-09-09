import { describe, expect, it } from "vitest";
import { buildInviteLink, parseInviteDeepLink } from "../inviteLink";
import { parseConnectLink } from "../connectLink";
import { parseNoteLink } from "../shareLink";

/**
 * Team-invitation links — the https page an admin shares and the
 * `baalda://invite/<id>?server=…` deep link it bounces into (#99).
 *
 * Same two-sided contract as `parseConnectLink`, and for the same reason: this
 * parser reads a URL that arrives from outside the app and carries a `server`
 * value which decides where a password gets posted. So every folding a platform
 * might hand us is accepted, and nothing but an http(s) address survives as the
 * server.
 */
describe("parseInviteDeepLink", () => {
  it("reads the id and the server", () => {
    expect(
      parseInviteDeepLink("baalda://invite/inv_123?server=https%3A%2F%2Fnotes.example.com"),
    ).toEqual({ invitationId: "inv_123", server: "https://notes.example.com" });
  });

  it("accepts the path-folded form some platforms deliver", () => {
    expect(
      parseInviteDeepLink("baalda:///invite/inv_123?server=https%3A%2F%2Fnotes.example.com"),
    ).toEqual({ invitationId: "inv_123", server: "https://notes.example.com" });
  });

  it("reads a link with no server at all (means: the current one)", () => {
    expect(parseInviteDeepLink("baalda://invite/inv_123")).toEqual({
      invitationId: "inv_123",
      server: null,
    });
  });

  it("keeps a reverse-proxy path prefix on the server", () => {
    expect(
      parseInviteDeepLink(
        "baalda://invite/inv_1?server=https%3A%2F%2Fintranet.example.com%2Fbaalda",
      )?.server,
    ).toBe("https://intranet.example.com/baalda");
  });

  it("gives a scheme-less server host https rather than refusing it", () => {
    expect(parseInviteDeepLink("baalda://invite/inv_1?server=notes.example.com")?.server).toBe(
      "https://notes.example.com",
    );
  });

  it("drops a server value that isn't an http(s) address, keeping the invite", () => {
    for (const bad of [
      "baalda://invite/inv_1?server=javascript%3Aalert(1)",
      "baalda://invite/inv_1?server=ftp%3A%2F%2Ffiles.example.com",
      "baalda://invite/inv_1?server=file%3A%2F%2F%2Fetc%2Fpasswd",
      "baalda://invite/inv_1?server=",
    ]) {
      // The id is still usable against the CURRENT server; only the address is
      // refused. Dropping the whole link here would turn a hostile query
      // parameter into a way to disable someone's invitation.
      expect(parseInviteDeepLink(bad)).toEqual({ invitationId: "inv_1", server: null });
    }
  });

  it("accepts a UUID, the shape Better Auth actually emits", () => {
    const id = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    expect(parseInviteDeepLink(`baalda://invite/${id}`)?.invitationId).toBe(id);
  });

  it("returns null for malformed input rather than throwing", () => {
    for (const bad of [
      "",
      "not a url",
      "baalda://invite",
      "baalda://invite/",
      "baalda://invite/a/b",
      "baalda://invite/has%20a%20space",
      `baalda://invite/${"x".repeat(129)}`,
      "https://notes.example.com/invite/inv_1",
      "otherapp://invite/inv_1",
    ]) {
      expect(parseInviteDeepLink(bad)).toBeNull();
    }
  });

  it("does not claim connect or note links, and neither claims an invite", () => {
    const invite = "baalda://invite/inv_1?server=https%3A%2F%2Fx.com";
    expect(parseConnectLink(invite)).toBeNull();
    expect(parseNoteLink(invite)).toBeNull();
    expect(parseInviteDeepLink("baalda://connect?server=https%3A%2F%2Fx.com")).toBeNull();
    expect(parseInviteDeepLink("baalda://note/org_1/doc_2")).toBeNull();
  });
});

describe("buildInviteLink", () => {
  it("builds the https page the invitee opens", () => {
    expect(buildInviteLink("https://notes.example.com", "inv_123")).toBe(
      "https://notes.example.com/invite/inv_123",
    );
  });

  it("normalizes the server first", () => {
    expect(buildInviteLink(" notes.example.com/ ", "inv_123")).toBe(
      "https://notes.example.com/invite/inv_123",
    );
  });

  it("keeps a reverse-proxy path prefix", () => {
    expect(buildInviteLink("https://intranet.example.com/baalda", "inv_1")).toBe(
      "https://intranet.example.com/baalda/invite/inv_1",
    );
  });

  it("refuses to build a link around a non-address or a bad id", () => {
    expect(buildInviteLink("javascript:alert(1)", "inv_1")).toBeNull();
    expect(buildInviteLink("https://notes.example.com", "../../etc/passwd")).toBeNull();
    expect(buildInviteLink("https://notes.example.com", "")).toBeNull();
  });
});
