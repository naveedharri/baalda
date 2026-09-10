// The rule that keeps the un-gated boot from re-introducing the seed hazard.
//
// Opening a MAPPED note before the registry has loaded its doc-id map means
// opening it with no provider and seeding the CRDT from the file — the exact
// reversal of pull-before-seed that `decideSeed` exists to forbid, and the shape
// of the note-doubling incident. So a folder we know syncs waits for the prime;
// anything we know will never sync opens at once.

import { describe, expect, it } from "vitest";
import { planOpen } from "../openGate";

describe("planOpen", () => {
  it("opens immediately once the sync layer is ready", () => {
    // Primed or enabled: `openNoteByPath` can register, and `openDoc` will find
    // the mapping. Nothing left to wait for, whatever the other inputs say.
    expect(
      planOpen({ syncReady: true, folderIsSynced: true, authStatus: "signed-in" }),
    ).toEqual({ action: "open" });
    expect(
      planOpen({ syncReady: true, folderIsSynced: null, authStatus: "unknown" }),
    ).toEqual({ action: "open" });
  });

  it("opens immediately when signed out — there is nothing to pull", () => {
    // Local-first: no session means no provider for any note, so waiting would
    // only delay a local open that is already correct.
    expect(
      planOpen({ syncReady: false, folderIsSynced: true, authStatus: "signed-out" }),
    ).toEqual({ action: "open" });
  });

  it("opens immediately for a folder that is genuinely local", () => {
    // No vault stamp on disk ⇒ no mapped notes ⇒ the local-only branch is the
    // right one, not a race.
    expect(
      planOpen({ syncReady: false, folderIsSynced: false, authStatus: "signed-in" }),
    ).toEqual({ action: "open" });
    expect(
      planOpen({ syncReady: false, folderIsSynced: false, authStatus: "unknown" }),
    ).toEqual({ action: "open" });
  });

  it("waits for a known-synced folder whose sync has not primed yet", () => {
    expect(
      planOpen({ syncReady: false, folderIsSynced: true, authStatus: "signed-in" }),
    ).toEqual({ action: "wait" });
  });

  it("waits while the folder's own state is still unknown", () => {
    // The stamp peek is one IPC fired off during the boot; a click that beats it
    // must not decide "local" by default — that is the guess that forks a doc.
    expect(
      planOpen({ syncReady: false, folderIsSynced: null, authStatus: "unknown" }),
    ).toEqual({ action: "wait" });
    expect(
      planOpen({ syncReady: false, folderIsSynced: null, authStatus: "signed-in" }),
    ).toEqual({ action: "wait" });
  });
});
