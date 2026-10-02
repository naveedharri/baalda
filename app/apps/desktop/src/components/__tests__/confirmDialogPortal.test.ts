// @vitest-environment jsdom
// #272: a confirm raised inside the Activity feed (`container-type: inline-size`,
// a containing block for `position: fixed`) was laid out and clipped inside the
// narrow column, so Restore version / Release could not be pressed. The confirm
// now portals to document.body; these pin that it leaves the host's DOM while
// keeping its clicks and Esc from leaking into the host's React handlers.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConfirmDialog } from "../ConfirmDialog";

let root: Root;
let host: HTMLDivElement;
const hostClick = vi.fn();
const hostEsc = vi.fn();
const onConfirm = vi.fn();
const onCancel = vi.fn();

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function render() {
  await act(async () =>
    root.render(
      createElement(
        "div",
        {
          className: "activity-feed",
          onClick: hostClick,
          // Like the right panel: close on an Esc nobody else handled.
          onKeyDown: (e: { key: string; defaultPrevented: boolean }) => {
            if (e.key === "Escape" && !e.defaultPrevented) hostEsc();
          },
        },
        createElement("button", { type: "button", className: "raiser" }, "Restore version"),
        createElement(ConfirmDialog, { title: "Restore this version?", confirmLabel: "Restore version", onConfirm, onCancel, children: "Body" }),
      ),
    ),
  );
}

const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]')!;
const button = (label: string) =>
  [...dialog().querySelectorAll("button")].find((b) => b.textContent === label)!;

it("renders outside the host so no ancestor can clip it", async () => {
  await render();
  expect(dialog()).not.toBeNull();
  expect(dialog().closest(".activity-feed")).toBeNull();
  expect(dialog().parentElement?.classList.contains("modal-backdrop")).toBe(true);
  expect(dialog().parentElement?.parentElement).toBe(document.body);
  expect(host.querySelector('[role="alertdialog"]')).toBeNull();
});

it("confirms and cancels without the click reaching the host's handlers", async () => {
  await render();
  await act(async () => button("Restore version").click());
  expect(onConfirm).toHaveBeenCalledTimes(1);
  await act(async () => button("Cancel").click());
  expect(onCancel).toHaveBeenCalledTimes(1);
  await act(async () => (dialog().parentElement as HTMLElement).click());
  expect(onCancel).toHaveBeenCalledTimes(2);
  expect(hostClick).not.toHaveBeenCalled();
});

it("takes focus, owns Esc, and hands focus back on close", async () => {
  const raiser = document.createElement("button");
  document.body.append(raiser);
  raiser.focus();
  await render();
  expect(document.activeElement).toBe(dialog());
  await act(async () => {
    dialog().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(hostEsc).not.toHaveBeenCalled();
  await act(async () => root.render(createElement("div")));
  expect(document.activeElement).toBe(raiser);
  raiser.remove();
});
