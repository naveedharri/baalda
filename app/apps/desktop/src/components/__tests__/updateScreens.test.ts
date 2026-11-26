// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UpdateGateView, updateGateProgress } from "../UpdateGateView";
import { WhatsNewDialog } from "../WhatsNewDialog";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../../lib/celebrate/celebrate", () => ({ runConfetti: () => () => {} }));
vi.mock("../../lib/ipc", () => ({ openExternal: vi.fn(async () => {}) }));

async function mount(el: ReturnType<typeof createElement>) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(el));
  return host;
}

describe("update card", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("says where the update stands, step by step", () => {
    expect(updateGateProgress({ phase: "checking" })).toMatchObject({ step: 0, text: "Checking for the update…" });
    expect(
      updateGateProgress({ phase: "downloading", version: "1", downloaded: 41_600_000, total: 96_800_000 }),
    ).toEqual({ step: 0, pct: 43, text: "43% · 41.6 of 96.8 MB" });
    expect(updateGateProgress({ phase: "downloading", version: "1", downloaded: 5_000_000, total: 0 })).toMatchObject({
      pct: null,
      text: "5.0 MB downloaded",
    });
    expect(updateGateProgress({ phase: "installing", version: "1" }).step).toBe(1);
    expect(updateGateProgress({ phase: "ready", version: "1" }).step).toBe(2);
  });

  it("shows the app icon, the version and the current step", async () => {
    const host = await mount(
      createElement(UpdateGateView, {
        update: { phase: "installing", version: "0.1.115" },
        version: "0.1.115",
        launching: true,
        required: null,
        working: true,
        onRetry: async () => {},
        onDownloadManually: () => {},
        onReload: () => {},
      }),
    );
    expect(host.querySelector(".update-gate-icon img")).not.toBeNull();
    expect(host.querySelector("h1")?.textContent).toBe("Updating Baalda");
    expect(host.querySelector(".update-gate-version")?.textContent).toBe("v0.1.115");
    const steps = [...host.querySelectorAll(".update-gate-steps li")].map((li) => li.className);
    expect(steps).toEqual(["is-done", "is-now", ""]);
  });
});

describe("What's New with a video", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  const video = { id: "AbC123xyz_0", url: "https://www.youtube.com/watch?v=AbC123xyz_0", title: "Access groups" };

  it("loads the player only when the video is tapped", async () => {
    const host = await mount(
      createElement(WhatsNewDialog, {
        version: "0.1.115",
        notes: [{ title: "Access groups", detail: "One place." }],
        video,
        onClose: () => {},
      }),
    );
    expect(host.ownerDocument.querySelector(".whats-new-badge-icon img")).not.toBeNull();
    expect(host.ownerDocument.querySelector("iframe")).toBeNull();
    const poster = host.ownerDocument.querySelector<HTMLButtonElement>(".whats-new-poster")!;
    expect(poster.textContent).toContain("Access groups");
    await act(async () => poster.click());
    const frame = host.ownerDocument.querySelector("iframe")!;
    expect(frame.src).toBe("https://www.youtube-nocookie.com/embed/AbC123xyz_0?autoplay=1&rel=0&playsinline=1");
    expect(host.ownerDocument.querySelector(".whats-new-poster")).toBeNull();
    expect(host.ownerDocument.querySelector(".whats-new-youtube")).not.toBeNull();
  });

  it("without a video it is today's card", async () => {
    const host = await mount(
      createElement(WhatsNewDialog, { version: "0.1.115", notes: [{ title: "A", detail: "B" }], video: null, onClose: () => {} }),
    );
    expect(host.ownerDocument.querySelector(".whats-new-video-block")).toBeNull();
    expect(host.ownerDocument.querySelectorAll(".whats-new-notes li").length).toBe(1);
  });
});
