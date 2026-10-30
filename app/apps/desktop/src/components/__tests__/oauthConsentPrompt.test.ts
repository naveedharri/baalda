import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConsentPromptBody } from "../OAuthConsentHost";
import type { OAuthConsentRequest } from "../../lib/api";

const base: OAuthConsentRequest = {
  id: "c1",
  clientId: "client-1",
  app: "Claude",
  organizationId: "org1",
  vaultName: "Team",
  vaultIds: ["v1"],
  approved: false,
};

describe("connector consent prompt (red team 3)", () => {
  it("a look-alike 'Claude' client shows where it really sends people", () => {
    const html = renderToStaticMarkup(
      createElement(ConsentPromptBody, { request: { ...base, redirectHosts: ["claude-ai.evil.example"] } }),
    );
    expect(html).toContain("Claude");
    expect(html).toContain("claude-ai.evil.example");
    expect(html).toContain("Allow only if you started this connection there yourself");
  });

  it("escapes a hostile name and host; an older server without hosts still warns", () => {
    const html = renderToStaticMarkup(
      createElement(ConsentPromptBody, {
        request: { ...base, app: "<img src=x onerror=alert(1)>", redirectHosts: ["<b>x</b>"] },
      }),
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>x</b>");
    const old = renderToStaticMarkup(createElement(ConsentPromptBody, { request: base }));
    expect(old).toContain("Allow only if you started this connection yourself");
  });
});
