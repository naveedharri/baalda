// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateVaultKey, vaultKeyFileText, vaultKeyToWords } from "../../lib/vaultKeys/crypto";

const restoreWithVaultKey = vi.fn();
const nudge = vi.fn();
vi.mock("../../lib/vaultKeys/runtime", () => ({
  currentVaultKeySession: () => ({ restoreWithVaultKey }),
  vaultKeysNudge: () => nudge(),
}));
vi.mock("../../lib/toast", () => ({ toast: vi.fn() }));
vi.mock("../../lib/ipc", () => ({ readExternalFile: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { RestoreVaultKeyDialog } from "../RestoreVaultKeyDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const vk = generateVaultKey();
const words = vaultKeyToWords(vk);

describe("Restore with vault key window", () => {
  let root: Root;
  let onClose: ReturnType<typeof vi.fn<() => void>>;
  let onRestored: ReturnType<typeof vi.fn<() => void>>;
  beforeEach(async () => {
    restoreWithVaultKey.mockReset();
    nudge.mockReset();
    onClose = vi.fn<() => void>();
    onRestored = vi.fn<() => void>();
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () =>
      root.render(createElement(RestoreVaultKeyDialog, { vaultId: "v1", vaultName: "Team notes", onClose, onRestored })),
    );
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
  });

  const area = () => document.querySelector("textarea.restore-key-input") as HTMLTextAreaElement;
  const restoreBtn = () =>
    [...document.querySelectorAll(".restore-key-actions button")].find((b) => b.textContent?.includes("Restore")) as HTMLButtonElement;
  const type = async (value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(area(), value);
      area().dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  it("is a dialog naming the vault, with Restore held until the words make a key", async () => {
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector(".restore-key-subtitle")?.textContent).toContain("Team notes");
    expect(document.querySelectorAll(".restore-key-slot")).toHaveLength(24);
    expect(restoreBtn().disabled).toBe(true);
    await type(words.split(" ").slice(0, 10).join(" "));
    expect(document.querySelectorAll(".restore-key-slot.filled")).toHaveLength(10);
    expect(restoreBtn().disabled).toBe(true);
  });

  it("takes the whole saved key file, restores, and closes", async () => {
    restoreWithVaultKey.mockResolvedValue("restored");
    await type(vaultKeyFileText("Team notes", "v1", vk));
    expect(document.querySelectorAll(".restore-key-slot.filled")).toHaveLength(24);
    expect(restoreBtn().disabled).toBe(false);
    await act(async () => restoreBtn().click());
    expect(restoreWithVaultKey).toHaveBeenCalledWith("v1", words);
    expect(onRestored).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    expect(nudge).toHaveBeenCalled();
  });

  it("stays open with the reason when the key belongs to another vault", async () => {
    restoreWithVaultKey.mockResolvedValue("wrong-key");
    await type(words);
    await act(async () => restoreBtn().click());
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector(".restore-key-error")?.textContent).toContain("different vault");
    await type(words + " ");
    expect(document.querySelector(".restore-key-error")).toBeNull();
  });

  it("stays open when the check cannot run (offline)", async () => {
    restoreWithVaultKey.mockRejectedValue(new Error("network"));
    await type(words);
    await act(async () => restoreBtn().click());
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector(".restore-key-error")?.textContent).toContain("Nothing was changed");
  });
});
