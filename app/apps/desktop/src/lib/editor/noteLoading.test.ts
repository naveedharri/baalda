// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { noteContentReady, shouldShowNoteSkeleton } from "./noteLoading";

describe("note loading lifecycle", () => {
  it("keeps the skeleton over an empty synced note until initial sync settles", () => {
    expect(noteContentReady({ textLength: 0, hasSync: true, syncStatus: "connecting" })).toBe(
      false,
    );
    expect(noteContentReady({ textLength: 0, hasSync: true, syncStatus: "synced" })).toBe(true);
  });

  it("does not delay cached content or local notes", () => {
    expect(noteContentReady({ textLength: 12, hasSync: true, syncStatus: "connecting" })).toBe(
      true,
    );
    expect(noteContentReady({ textLength: 0, hasSync: false, syncStatus: "offline" })).toBe(true);
  });

  it("does not mistake the previous note's mounted view for the requested note", () => {
    expect(
      shouldShowNoteSkeleton({
        requestedPath: "next.md",
        mountedPath: "previous.md",
        readyPath: "previous.md",
        openingAnother: false,
      }),
    ).toBe(true);
  });

  it("removes the skeleton only when the requested note is mounted and ready", () => {
    expect(
      shouldShowNoteSkeleton({
        requestedPath: "note.md",
        mountedPath: "note.md",
        readyPath: "note.md",
        openingAnother: false,
      }),
    ).toBe(false);
  });
});
