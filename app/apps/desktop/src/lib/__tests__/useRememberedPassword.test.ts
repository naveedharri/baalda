// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRememberedPassword } from "../useRememberedPassword";
import { loadRememberedPassword } from "../rememberedPassword";
vi.mock("../rememberedPassword", () => ({ loadRememberedPassword: vi.fn() }));
let root: Root;
let host: HTMLDivElement;
let result: ReturnType<typeof useRememberedPassword>;
let props: { server: string; email: string; mode: string; step: string; enabled: boolean };
function Probe() {
  result = useRememberedPassword(props.server, props.email, props.mode, props.step, props.enabled);
  return createElement("input", { value: result[0], readOnly: true });
}
const render = async () => { await act(async () => root.render(createElement(Probe))); };
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  vi.mocked(loadRememberedPassword).mockResolvedValue("saved");
  props = { server: "https://one.test", email: "ada@example.com", mode: "sign-in", step: "form", enabled: true };
  host = document.createElement("div"); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); });
it("prefills on reopen, but never on sign-up or an unconfirmed server", async () => {
  await render(); expect(result[0]).toBe("saved");
  props.mode = "sign-up"; await render(); expect(result[0]).toBe("");
  props.mode = "sign-in"; props.step = "confirm-link"; await render(); expect(result[0]).toBe("");
  expect(loadRememberedPassword).toHaveBeenCalledTimes(1);
});
it("does not overwrite typing when the keychain responds late", async () => {
  let finish!: (value: string) => void;
  vi.mocked(loadRememberedPassword).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  await render();
  act(() => result[1]("typed"));
  await act(async () => finish("saved"));
  expect(result[0]).toBe("typed");
});
it("keeps manually entered passwords when opting in", async () => {
  props.enabled = false; await render();
  act(() => result[1]("typed"));
  props.enabled = true; await render();
  expect(result[0]).toBe("typed");
  expect(loadRememberedPassword).not.toHaveBeenCalled();
});
it("clears old credentials and ignores late reads when switching server or email", async () => {
  let finish!: (value: string) => void;
  vi.mocked(loadRememberedPassword).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue("");
  await render();
  props.server = "https://two.test"; await render();
  await act(async () => finish("wrong-server-secret"));
  expect(result[0]).toBe("");
  act(() => result[1]("typed"));
  props.email = "other@example.com"; await render(); expect(result[0]).toBe("");
});
it("clears an autofilled password when remembering is disabled", async () => {
  await render(); expect(result[0]).toBe("saved");
  props.enabled = false; await render(); expect(result[0]).toBe("");
});
