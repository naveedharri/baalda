// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AuthDialog } from "../AuthDialog";
import { useStore } from "../../store";
import { saveRememberedPassword } from "../../lib/rememberedPassword";
vi.mock("../../store", async () => {
  const { create } = await import("zustand");
  return { useStore: create(() => ({})) };
});
vi.mock("../../lib/auth/authManager", () => ({ authManager: { api: { getAuthMethods: async () => ({ google: false, passwordReset: false }) } } }));
vi.mock("../../lib/prefs", () => ({ readServerChoice: () => "custom", writeServerChoice: vi.fn() }));
vi.mock("../../lib/rememberedEmail", () => ({ initialEmail: () => "ada@example.com", readRememberedEmail: () => "ada@example.com", rememberEmailAddress: vi.fn(), writeRememberEmail: vi.fn() }));
vi.mock("../../lib/rememberedPassword", () => ({ readRememberPassword: () => true, saveRememberedPassword: vi.fn(), writeRememberPassword: vi.fn() }));
vi.mock("../../lib/useRememberedPassword", () => ({ useRememberedPassword: () => ["valid-password", vi.fn()] }));
let root: Root;
let host: HTMLDivElement;
const signIn = vi.fn();
const signUp = vi.fn();
const closed = vi.fn();
const patch = (state: Record<string, unknown>) => (useStore as unknown as { setState: (state: Record<string, unknown>) => void }).setState(state);
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  patch({ serverUrl: "https://notes.example.com", authStatus: "signed-out", authError: null, pendingServerLink: null, invitePrompt: null, signIn, signUp });
  host = document.createElement("div"); root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));
const render = async (initialMode: "sign-in" | "sign-up" = "sign-in") => {
  await act(async () => root.render(createElement(AuthDialog, { onClose: closed, initialMode })));
};
const submit = async () => {
  await act(async () => document.body.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
};
it("saves after successful sign-in and waits for the keychain before closing", async () => {
  signIn.mockImplementation(async () => patch({ authStatus: "signed-in" }));
  let finish!: () => void;
  vi.mocked(saveRememberedPassword).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  await render(); await submit();
  expect(signIn).toHaveBeenCalledWith("ada@example.com", "valid-password");
  expect(saveRememberedPassword).toHaveBeenCalledWith("https://notes.example.com", "ada@example.com", "valid-password");
  expect(closed).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(closed).toHaveBeenCalled();
});
it("never saves a rejected password", async () => {
  signIn.mockRejectedValue(new Error("invalid credentials"));
  await render(); await submit();
  expect(saveRememberedPassword).not.toHaveBeenCalled();
  expect(closed).not.toHaveBeenCalled();
});
it("saves a successful sign-up password", async () => {
  signUp.mockResolvedValue(undefined);
  await render("sign-up"); await submit();
  expect(signUp).toHaveBeenCalled();
  expect(saveRememberedPassword).toHaveBeenCalledWith("https://notes.example.com", "ada@example.com", "valid-password");
});
it("reports keychain save failure without treating authentication as failed", async () => {
  signIn.mockImplementation(async () => patch({ authStatus: "signed-in" }));
  vi.mocked(saveRememberedPassword).mockRejectedValue(new Error("locked"));
  await render(); await submit();
  expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("You're signed in");
  expect(closed).not.toHaveBeenCalled();
  const button = [...document.body.querySelectorAll("button")].find((b) => b.textContent === "Continue")!;
  await act(async () => button.click());
  expect(closed).toHaveBeenCalled();
});

it("portals the sign-in modal outside a constrained sidebar", async () => {
  await render();
  expect(host.querySelector(".modal-backdrop")).toBeNull();
  expect(document.body.querySelector(".modal-backdrop")?.parentElement).toBe(document.body);
});
