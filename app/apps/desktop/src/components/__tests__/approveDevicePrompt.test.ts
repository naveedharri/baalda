import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApproveDevicePrompt } from "../VaultKeyPrompts";

describe("ApproveDevicePrompt (red team 3)", () => {
  it("never shows the device's code: the person must type what the new computer shows", () => {
    const device = { deviceId: "d-evil", publicKey: "AAAA", code: "c0de f00d" };
    const html = renderToStaticMarkup(createElement(ApproveDevicePrompt, { device, done: () => {} }));
    expect(html).not.toContain("c0de");
    expect(html).not.toContain("f00d");
    expect(html).toContain("Code shown on the new computer");
    // Approve starts disabled until a full code is typed.
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*Approve/);
  });
});
