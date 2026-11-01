import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApproveDevicePrompt } from "../VaultKeyPrompts";

describe("ApproveDevicePrompt (one click, seamless keys E)", () => {
  it("shows the device's code read-only with Approve / Not me and no typing", () => {
    const device = { deviceId: "d1", publicKey: "AAAA", code: "c0de f00d", name: "MacBook Pro" };
    const html = renderToStaticMarkup(createElement(ApproveDevicePrompt, { device, done: () => {} }));
    expect(html).toContain("MacBook Pro is signing in");
    expect(html).toContain("c0de f00d");
    expect(html).not.toContain("<input");
    expect(html).toContain("Approve");
    expect(html).toContain("Not me");
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>[\s\S]*Approve/);
  });
});
