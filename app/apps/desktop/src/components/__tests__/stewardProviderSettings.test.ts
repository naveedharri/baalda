// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { StewardProviderSettings } from "../StewardProviderSettings";
const keys = vi.hoisted(() => ({ keychainGet: vi.fn(), keychainSet: vi.fn(), keychainDelete: vi.fn() }));
vi.mock("../../lib/ipc", () => keys);
it("loads the identity-scoped key securely, defaults to Jev and disables inference when toggled off", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  keys.keychainGet.mockResolvedValue("sk-or-test-key");
  const host = document.createElement("div"); const root = createRoot(host); const onChange = vi.fn();
  try {
    await act(async () => root.render(createElement(StewardProviderSettings, { identity: "account", onChange })));
    expect(keys.keychainGet).toHaveBeenCalledWith("steward:openrouter:account");
    expect(onChange).toHaveBeenLastCalledWith({ name: "openrouter", apiKey: "sk-or-test-key", model: "typesafe/jev-1.13", mode: "decisions" });
    await act(async () => (host.querySelector('[aria-label="Model"]') as HTMLButtonElement).click());
    const choices = [...document.querySelectorAll('[role="menuitemradio"]')];
    expect(choices).toHaveLength(8);
    await act(async () => (choices.find(option => option.textContent?.includes("GPT-6 Astra")) as HTMLElement).click());
    expect(onChange).toHaveBeenLastCalledWith({ name: "openrouter", apiKey: "sk-or-test-key", model: "openai/gpt-6-astra", mode: "chat" });
    expect(host.querySelector('input[type="password"]')).toBeNull();
    await act(async () => (host.querySelector('[role="switch"]') as HTMLInputElement).click());
    expect(onChange).toHaveBeenLastCalledWith(null);
    await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === "Remove key")!.click());
    expect(keys.keychainDelete).toHaveBeenCalledWith("steward:openrouter:account");
    expect(host.textContent).toContain("Key removed");
  } finally { await act(async () => root.unmount()); }
});
