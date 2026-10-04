// @vitest-environment jsdom
// The editor column has ONE notice slot: at most one top banner at a time, in
// priority order (held delete > reconcile summary > open note removed > the
// rest), each informational one fading after 20 s without losing its record.
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ release: vi.fn(async (_how: string) => {}) }));

vi.mock("../../lib/ipc", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(Object.keys(real).map((k) => [k, vi.fn(async () => null)]));
});
// No exit animation under fake timers: a hidden banner leaves the DOM at once.
vi.mock("motion/react", async () => {
  const { createElement: el } = await import("react");
  return {
    AnimatePresence: ({ children }: { children: unknown }) => children,
    motion: {
      div: ({ className, children }: { className?: string; children?: unknown }) =>
        el("div", { className }, children as never),
    },
    useReducedMotion: () => true,
  };
});
vi.mock("../../store", async () => {
  const { create } = await import("zustand");
  const useStore = create<Record<string, unknown>>(() => ({}));
  return { useStore };
});

import { useStore } from "../../store";
import { HeldDeleteNotice } from "../HeldDeleteNotice";
import { NoteRemovedNotice } from "../NoteRemovedNotice";
import { ReconcileBanner, RECONCILE_BANNER_DEBOUNCE_MS } from "../ReconcileBanner";
import { reconcileReport } from "../../lib/sync/reconcileReport";
import { buildActivity } from "../activityRows";
import { NOTICE_FADE_MS, NOTICE_PRIORITY, pickNotice, resetNoticeSlot } from "../../lib/noticeSlot";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const store = useStore as unknown as {
  setState: (s: Record<string, unknown>) => void;
  getState: () => Record<string, unknown>;
};

let host: HTMLDivElement;
let root: Root;

function setHeld(count: number | null) {
  store.setState({
    structureNotice: {
      rootMissing: false,
      pendingDelete: count == null ? null : { count },
      closedAppChanges: false,
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetNoticeSlot();
  reconcileReport.clear();
  h.release.mockReset();
  // Releasing the hold clears it, exactly like the sync layer does.
  h.release.mockImplementation(async () => setHeld(null));
  store.setState({
    vault: null,
    noteRemovedByTeammate: null,
    releaseBulkDelete: h.release,
    openRightPanel: vi.fn(),
  });
  setHeld(null);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const text = () => host.textContent ?? "";
const buttons = () => [...host.querySelectorAll("button")].map((b) => b.textContent);
const click = (label: string) =>
  act(() => {
    [...host.querySelectorAll("button")].find((b) => b.textContent === label)!.click();
  });
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function mountAll() {
  act(() =>
    root.render(
      createElement(
        Fragment,
        null,
        createElement(HeldDeleteNotice),
        createElement(ReconcileBanner),
        createElement(NoteRemovedNotice),
      ),
    ),
  );
}

describe("pickNotice", () => {
  it("puts held delete, then reconcile, then the note's removal first", () => {
    expect(NOTICE_PRIORITY.slice(0, 3)).toEqual(["held-delete", "reconcile", "note-removed"]);
    expect(pickNotice(new Set(["note-removed", "reconcile", "held-delete"]))).toBe("held-delete");
    expect(pickNotice(new Set(["note-removed", "not-syncing", "reconcile"]))).toBe("reconcile");
    expect(pickNotice(new Set(["attachment-local-only", "note-removed"]))).toBe("note-removed");
    expect(pickNotice(new Set())).toBeNull();
  });
});

describe("held bulk delete notice", () => {
  it("informs with Restore now + Dismiss and offers no delete", async () => {
    setHeld(12);
    mountAll();
    expect(text()).toContain("You removed 12 notes on this device. They stay for your team and will be restored here.");
    expect(buttons()).toEqual(["Restore now", "Dismiss"]);
    expect(text()).not.toContain("Delete for everyone");
  });

  it("Restore now restores immediately", async () => {
    setHeld(12);
    mountAll();
    click("Restore now");
    await advance(0);
    expect(h.release).toHaveBeenCalledWith("restore");
    expect(text()).not.toContain("You removed");
  });

  it("Dismiss releases the hold", async () => {
    setHeld(12);
    mountAll();
    click("Dismiss");
    await advance(0);
    expect(h.release).toHaveBeenCalledWith("dismiss");
  });

  it("fades after 20 s by releasing the hold, so the pull restores", async () => {
    setHeld(12);
    mountAll();
    await advance(NOTICE_FADE_MS - 1);
    expect(h.release).not.toHaveBeenCalled();
    await advance(1);
    expect(h.release).toHaveBeenCalledWith("dismiss");
    expect(text()).not.toContain("You removed");
  });
});

describe("one notice at a time", () => {
  it("three simultaneous notices show one by one in priority order", async () => {
    setHeld(12);
    store.setState({ noteRemovedByTeammate: { reason: "revoked", trashedTo: null } });
    reconcileReport.record({ kind: "selfRevoked", path: "A.md", docId: "a" } as never);
    reconcileReport.record({ kind: "selfRevoked", path: "B.md", docId: "b" } as never);
    mountAll();
    await advance(RECONCILE_BANNER_DEBOUNCE_MS);

    expect(host.querySelectorAll(".banner")).toHaveLength(1);
    expect(text()).toContain("You removed 12 notes");

    // The held delete fades; the reconcile summary takes the slot.
    await advance(NOTICE_FADE_MS);
    await advance(0);
    expect(host.querySelectorAll(".banner")).toHaveLength(1);
    expect(text()).not.toContain("You removed 12 notes");
    expect(host.querySelector(".reconcile-banner")).not.toBeNull();
    expect(text()).not.toContain("Your access to this note was removed");

    // Dismissed: the open note's removal is next.
    click("Dismiss");
    await advance(0);
    expect(host.querySelectorAll(".banner")).toHaveLength(1);
    expect(text()).toContain("Your access to this note was removed. It is no longer on this device.");

    // It fades too, and the slot is empty.
    await advance(NOTICE_FADE_MS);
    await advance(0);
    expect(host.querySelectorAll(".banner")).toHaveLength(0);
    expect(store.getState().noteRemovedByTeammate).toBeNull();
  });

  it("a faded reconcile notice is still in the Activity list", async () => {
    reconcileReport.record({ kind: "selfRevoked", path: "A.md", docId: "a" } as never);
    mountAll();
    await advance(RECONCILE_BANNER_DEBOUNCE_MS);
    expect(host.querySelector(".reconcile-banner")).not.toBeNull();

    await advance(NOTICE_FADE_MS);
    await advance(0);
    expect(host.querySelector(".reconcile-banner")).toBeNull();

    const rows = buildActivity({ reconcile: reconcileReport.items(), trash: [], copies: [] });
    expect(rows.filter((r) => r.type === "reconcile").map((r) => r.path)).toEqual(["A.md"]);
  });
});
