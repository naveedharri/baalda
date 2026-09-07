import { describe, expect, it } from "vitest";
import {
  decideAuthStep,
  impliedServerChoice,
  normalizeServerUrl,
  serverHost,
} from "../serverChoice";

/**
 * The server-choice step's decision table (#91).
 *
 * There is no component-render harness in this workspace, so the rules that
 * decide WHERE the sign-in dialog opens — and what counts as a server address —
 * live in pure functions and get pinned here. The stake is not cosmetic: get
 * `decideAuthStep` wrong in the "never asked" direction and a self-hosting
 * team's members go back to signing up on the managed instance; get
 * `normalizeServerUrl` wrong and a deep link decides where a password is
 * posted.
 */
describe("normalizeServerUrl", () => {
  it("prepends https to a bare host", () => {
    expect(normalizeServerUrl("notes.example.com")).toBe("https://notes.example.com");
  });

  it("strips trailing slashes but keeps a reverse-proxy path prefix", () => {
    expect(normalizeServerUrl("https://intranet.example.com/baalda/")).toBe(
      "https://intranet.example.com/baalda",
    );
    expect(normalizeServerUrl("https://api.baalda.com///")).toBe("https://api.baalda.com");
  });

  it("keeps an explicit port and honours http for a local server", () => {
    expect(normalizeServerUrl("http://localhost:3010")).toBe("http://localhost:3010");
    expect(normalizeServerUrl(" https://notes.example.com:8443 ")).toBe(
      "https://notes.example.com:8443",
    );
  });

  it("drops the default port and lowercases the host", () => {
    expect(normalizeServerUrl("https://Notes.Example.com:443")).toBe(
      "https://notes.example.com",
    );
  });

  it("refuses anything that isn't http(s)", () => {
    for (const bad of [
      "javascript:alert(1)",
      "javascript://alert(1)",
      "ftp://files.example.com",
      "file:///etc/passwd",
      "data:text/html,<script>",
    ]) {
      expect(normalizeServerUrl(bad)).toBeNull();
    }
  });

  it("refuses empty and malformed input", () => {
    for (const bad of ["", "   ", "https://", "http://", "://nope"]) {
      expect(normalizeServerUrl(bad)).toBeNull();
    }
  });
});

describe("serverHost", () => {
  it("names the host, with any path prefix that distinguishes two instances", () => {
    expect(serverHost("https://api.baalda.com")).toBe("api.baalda.com");
    expect(serverHost("http://localhost:3010")).toBe("localhost:3010");
    expect(serverHost("https://intranet.example.com/baalda")).toBe(
      "intranet.example.com/baalda",
    );
  });

  it("falls back to the raw string rather than rendering nothing", () => {
    expect(serverHost("not a url")).toBe("not a url");
  });
});

describe("impliedServerChoice", () => {
  const def = "https://api.baalda.com";

  it("reads a non-default URL as a self-host answer already given", () => {
    expect(impliedServerChoice("https://notes.example.com", def)).toBe("custom");
  });

  it("treats the default (however it was spelled) as no answer", () => {
    expect(impliedServerChoice(def, def)).toBeNull();
    expect(impliedServerChoice("https://api.baalda.com/", def)).toBeNull();
  });
});

describe("decideAuthStep", () => {
  const def = "https://api.baalda.com";

  it("asks on a first run with nothing persisted", () => {
    expect(
      decideAuthStep({ choice: null, serverUrl: def, defaultServerUrl: def }),
    ).toBe("choose-server");
  });

  it("does not ask again once the question is answered", () => {
    expect(
      decideAuthStep({ choice: "managed", serverUrl: def, defaultServerUrl: def }),
    ).toBe("form");
    expect(
      decideAuthStep({
        choice: "custom",
        serverUrl: "https://notes.example.com",
        defaultServerUrl: def,
      }),
    ).toBe("form");
  });

  it("does not ask a pre-#91 device that already points at its own server", () => {
    // It answered through the old <details>; asking again risks defaulting it
    // to managed, which is the whole bug.
    expect(
      decideAuthStep({
        choice: null,
        serverUrl: "https://notes.example.com",
        defaultServerUrl: def,
      }),
    ).toBe("form");
  });

  it("lets a pending invite link outrank every other step", () => {
    for (const choice of [null, "managed", "custom"] as const) {
      expect(
        decideAuthStep({
          choice,
          serverUrl: def,
          pendingServerLink: "https://notes.example.com",
          defaultServerUrl: def,
        }),
      ).toBe("confirm-link");
    }
  });

  it("ignores an empty pending link", () => {
    expect(
      decideAuthStep({
        choice: "managed",
        serverUrl: def,
        pendingServerLink: "",
        defaultServerUrl: def,
      }),
    ).toBe("form");
  });
});
