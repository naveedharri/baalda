import { describe, expect, it } from "vitest";
import { buildConnectLink, parseConnectLink } from "../connectLink";
import { parseNoteLink } from "../shareLink";

/**
 * Server-invite links — `baalda://connect?server=<url>` (#91).
 *
 * A self-hosting admin sends one link instead of dictating a URL, which means
 * this parser reads a value that decides where a password gets posted. So the
 * tests pin both halves of the contract: every folding a platform might hand us
 * is accepted, and nothing but an http(s) address survives.
 */
describe("parseConnectLink", () => {
  it("round-trips a built link", () => {
    const link = buildConnectLink("https://notes.example.com");
    expect(link).toBe("baalda://connect?server=https%3A%2F%2Fnotes.example.com");
    expect(parseConnectLink(link!)).toBe("https://notes.example.com");
  });

  it("accepts the Staging app's scheme (the two builds must not share one)", () => {
    expect(parseConnectLink("baalda-staging://connect?server=https%3A%2F%2Fnotes.example.com")).toBe(
      "https://notes.example.com",
    );
  });

  it("accepts the path-folded form some platforms deliver", () => {
    expect(parseConnectLink("baalda:///connect?server=https%3A%2F%2Fnotes.example.com")).toBe(
      "https://notes.example.com",
    );
  });

  it("keeps a reverse-proxy path prefix", () => {
    expect(
      parseConnectLink("baalda://connect?server=https%3A%2F%2Fintranet.example.com%2Fbaalda"),
    ).toBe("https://intranet.example.com/baalda");
  });

  it("gives a scheme-less host https rather than refusing it", () => {
    expect(parseConnectLink("baalda://connect?server=notes.example.com")).toBe(
      "https://notes.example.com",
    );
  });

  it("refuses a server value that isn't an http(s) address", () => {
    for (const bad of [
      "baalda://connect?server=javascript%3Aalert(1)",
      "baalda://connect?server=ftp%3A%2F%2Ffiles.example.com",
      "baalda://connect?server=file%3A%2F%2F%2Fetc%2Fpasswd",
      "baalda://connect?server=",
    ]) {
      expect(parseConnectLink(bad)).toBeNull();
    }
  });

  it("returns null for malformed input rather than throwing", () => {
    for (const bad of [
      "",
      "not a url",
      "baalda://connect",
      "baalda://connect/extra?server=https%3A%2F%2Fx.com",
      "https://notes.example.com/open/connect",
      "otherapp://connect?server=https%3A%2F%2Fx.com",
    ]) {
      expect(parseConnectLink(bad)).toBeNull();
    }
  });

  it("does not claim note links, and note links still parse", () => {
    const note = "baalda://note/org_1/doc_2";
    expect(parseConnectLink(note)).toBeNull();
    expect(parseNoteLink(note)).toEqual({ orgId: "org_1", docId: "doc_2" });
    // …and a connect link is not mistaken for a note.
    expect(parseNoteLink("baalda://connect?server=https%3A%2F%2Fx.com")).toBeNull();
  });
});

describe("buildConnectLink", () => {
  it("normalizes before encoding", () => {
    expect(buildConnectLink(" notes.example.com/ ")).toBe(
      "baalda://connect?server=https%3A%2F%2Fnotes.example.com",
    );
  });

  it("refuses to build a link around a non-address", () => {
    expect(buildConnectLink("javascript:alert(1)")).toBeNull();
  });
});
