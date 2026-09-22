// @vitest-environment jsdom
//
// The signed-out / not-syncing banner (#145).
//
// The load-bearing assertions are the NEGATIVE ones: this strip is an alarm, and
// an alarm that cries wolf at every launch (auth still restoring) or in every
// local folder gets ignored exactly like the corner pill it replaces. So the
// four silent cases are pinned as hard as the two loud ones.
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NotSyncingBannerView, notSyncingReason } from "../NotSyncingBanner";

const signedOutOnSyncedVault = {
  authStatus: "signed-out",
  hasSession: false,
  syncStatus: "offline",
  folderIsSynced: true,
  noteOpen: true,
} as const;

describe("notSyncingReason", () => {
  it("names the signed-out state in a synced vault", () => {
    expect(notSyncingReason(signedOutOnSyncedVault)).toBe("signed-out");
  });

  it("reports signed out whatever the socket last said", () => {
    // A 401 at token mint maps to "offline" (`mintFailureStatus`), which is the
    // very disguise this banner exists to strip off — so the auth fact must win
    // over every sync status, not just the quiet one.
    for (const syncStatus of ["offline", "connecting", "error", "synced"] as const) {
      expect(notSyncingReason({ ...signedOutOnSyncedVault, syncStatus })).toBe("signed-out");
    }
  });

  it("stays silent in a folder that is not a synced vault", () => {
    expect(
      notSyncingReason({ ...signedOutOnSyncedVault, folderIsSynced: false }),
    ).toBeNull();
  });

  it("stays silent until the vault stamp peek has landed", () => {
    expect(notSyncingReason({ ...signedOutOnSyncedVault, folderIsSynced: null })).toBeNull();
  });

  it("stays silent while auth is still restoring", () => {
    // The window between first paint and the session restore. "Signed out" here
    // would flash at every user on every launch.
    expect(
      notSyncingReason({
        ...signedOutOnSyncedVault,
        authStatus: "unknown",
      }),
    ).toBeNull();
  });

  it("stays silent for a signed-in vault that is syncing", () => {
    expect(
      notSyncingReason({
        authStatus: "signed-in",
        hasSession: true,
        syncStatus: "synced",
        folderIsSynced: true,
        noteOpen: true,
      }),
    ).toBeNull();
  });

  it("stays silent for a signed-in vault that is merely offline or reconnecting", () => {
    // These resolve themselves and the corner pill already says so; a permanent
    // strip over them is the noise that makes the real alarm invisible.
    for (const syncStatus of ["offline", "connecting", "error", "read-only"] as const) {
      expect(
        notSyncingReason({
          authStatus: "signed-in",
          hasSession: true,
          syncStatus,
          folderIsSynced: true,
          noteOpen: true,
        }),
      ).toBeNull();
    }
  });

  it("names a withdrawn grant on a signed-in vault", () => {
    expect(
      notSyncingReason({
        authStatus: "signed-in",
        hasSession: true,
        syncStatus: "no-access",
        folderIsSynced: true,
        noteOpen: true,
      }),
    ).toBe("no-access");
  });

  it("distinguishes a connected vault with a denied note from revoked membership", () => {
    const state = { ...signedOutOnSyncedVault, authStatus: "signed-in" as const, hasSession: true, syncStatus: "no-access" as const };
    expect(notSyncingReason({ ...state, vaultSyncStatus: "synced" })).toBe("no-access");
    expect(notSyncingReason({ ...state, vaultSyncStatus: "no-access", noteOpen: false })).toBe("vault-no-access");
  });

  it("drops a stale no-access once the note is closed", () => {
    // `syncStatus` belongs to the open doc's socket and `closeNote` leaves the
    // last verdict in place, so the empty pane must not keep accusing the vault.
    expect(
      notSyncingReason({
        authStatus: "signed-in",
        hasSession: true,
        syncStatus: "no-access",
        folderIsSynced: true,
        noteOpen: false,
      }),
    ).toBeNull();
  });

  it("still reports signed out with no note open", () => {
    expect(notSyncingReason({ ...signedOutOnSyncedVault, noteOpen: false })).toBe(
      "signed-out",
    );
  });

  it("treats a signed-in status with no session object as signed out", () => {
    expect(
      notSyncingReason({
        authStatus: "signed-in",
        hasSession: false,
        syncStatus: "synced",
        folderIsSynced: true,
        noteOpen: true,
      }),
    ).toBe("signed-out");
  });
});

describe("NotSyncingBannerView", () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;

  beforeAll(() => {
    // `useReducedMotion` asks the platform; jsdom ships no matchMedia.
    if (!window.matchMedia) {
      window.matchMedia = ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      })) as unknown as typeof window.matchMedia;
    }
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  function render(props: Parameters<typeof NotSyncingBannerView>[0]): HTMLElement {
    host = document.createElement("div");
    document.body.appendChild(host);
    const r = createRoot(host);
    root = r;
    act(() => r.render(createElement(NotSyncingBannerView, props)));
    return host;
  }

  it("renders nothing when there is no reason", () => {
    const el = render({ reason: null, onSignIn: () => {} });
    expect(el.querySelector(".not-syncing-banner")).toBeNull();
  });

  it("says signed out and offers Sign in", () => {
    const onSignIn = vi.fn();
    const el = render({ reason: "signed-out", onSignIn });
    const banner = el.querySelector(".not-syncing-banner");
    expect(banner).not.toBeNull();
    // An alarm, not a status line — screen readers should interrupt for it.
    expect(banner?.getAttribute("role")).toBe("alert");
    expect(banner?.textContent).toContain("Signed out");
    expect(banner?.textContent).toContain("not syncing");
  });

  it("invokes the sign-in action when Sign in is clicked", () => {
    const onSignIn = vi.fn();
    const el = render({ reason: "signed-out", onSignIn });
    const button = [...el.querySelectorAll("button")].find(
      (b) => b.textContent === "Sign in",
    );
    expect(button).toBeTruthy();
    act(() => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });

  it("names a withdrawn grant without offering Sign in", () => {
    const el = render({ reason: "no-access", onSignIn: () => {} });
    const banner = el.querySelector(".not-syncing-banner");
    expect(banner?.textContent).toContain("You no longer have access to this note");
    expect(banner?.textContent).not.toContain("access to this vault");
    expect(banner?.textContent).toContain("not syncing");
    expect(banner?.querySelector("button")).toBeNull();
  });

  it("has no dismiss control — the banner leaves when the state does", () => {
    const el = render({ reason: "signed-out", onSignIn: () => {} });
    const labels = [...el.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).not.toContain("Dismiss");
  });
});
