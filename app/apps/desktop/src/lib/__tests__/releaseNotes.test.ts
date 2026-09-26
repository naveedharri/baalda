import { describe, it, expect } from "vitest";
import {
  SILENT_RELEASE_MARKER,
  isSilentRelease,
  notesForVersion,
  releaseNoteLines,
} from "../releaseNotes";

/** A body shaped like docs/RELEASE_NOTES.md: comment header, newest-first sections. */
const MULTI = `<!--
  Authoring rules that must never reach a user.
  - One \`## <version>\` section per release.
-->

## 0.1.61

- Baalda now updates itself at a quiet moment.
- What's New covers only the version you were given.

## 0.1.60

- Fixed a crash that emptied the whole window.
- The loading bars appear the moment you click a note.

## 0.1.59

- The sync light describes your vault, not the open note.
`;

describe("notesForVersion", () => {
  it("returns only the section matching the version", () => {
    const picked = notesForVersion(MULTI, "0.1.60");
    expect(releaseNoteLines(picked)).toEqual([
      "Fixed a crash that emptied the whole window.",
      "The loading bars appear the moment you click a note.",
    ]);
  });

  it("does not leak the neighbouring sections' points", () => {
    const picked = notesForVersion(MULTI, "0.1.60");
    expect(picked).not.toContain("updates itself");
    expect(picked).not.toContain("sync light");
  });

  it("matches a version written with a leading v", () => {
    expect(releaseNoteLines(notesForVersion(MULTI, "v0.1.59"))).toEqual([
      "The sync light describes your vault, not the open note.",
    ]);
  });

  it("falls back to the first (newest) section when no heading matches", () => {
    expect(releaseNoteLines(notesForVersion(MULTI, "9.9.9"))).toEqual([
      "Baalda now updates itself at a quiet moment.",
      "What's New covers only the version you were given.",
    ]);
  });

  it("falls back to the first section when no version is given", () => {
    expect(releaseNoteLines(notesForVersion(MULTI))).toEqual([
      "Baalda now updates itself at a quiet moment.",
      "What's New covers only the version you were given.",
    ]);
  });

  it("returns a headingless body whole", () => {
    const body = "- One thing changed\n- And another";
    expect(releaseNoteLines(notesForVersion(body, "0.1.61"))).toEqual([
      "One thing changed",
      "And another",
    ]);
  });

  it("strips HTML comments, including the authoring rules header", () => {
    const picked = notesForVersion(MULTI, "0.1.61");
    expect(picked).not.toContain("Authoring rules");
    expect(picked).not.toContain("<!--");
    expect(picked).not.toContain("-->");
  });

  it("strips an HTML comment from a headingless body too", () => {
    const body = "<!-- internal -->\n- Only this line";
    expect(releaseNoteLines(notesForVersion(body, "0.1.61"))).toEqual([
      "Only this line",
    ]);
  });

  it("drops preamble that sits above the first heading", () => {
    const body = "Some intro prose\n\n## 0.1.61\n\n- The real point";
    expect(releaseNoteLines(notesForVersion(body, "0.1.61"))).toEqual([
      "The real point",
    ]);
  });

  it("is empty for an empty body", () => {
    expect(notesForVersion("", "0.1.61")).toBe("");
    expect(notesForVersion(null, "0.1.61")).toBe("");
    expect(notesForVersion(undefined)).toBe("");
  });
});

describe("releaseNoteLines", () => {
  it("caps at five points by default", () => {
    const body = Array.from({ length: 9 }, (_, i) => `- point ${i + 1}`).join(
      "\n",
    );
    const lines = releaseNoteLines(body);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("point 1");
    expect(lines[4]).toBe("point 5");
  });

  it("honours an explicit cap", () => {
    const body = Array.from({ length: 9 }, (_, i) => `- point ${i + 1}`).join(
      "\n",
    );
    expect(releaseNoteLines(body, 2)).toEqual(["point 1", "point 2"]);
  });

  it("unwraps bold markers", () => {
    expect(releaseNoteLines("- Press **⌘K** to **link**")).toEqual([
      "Press ⌘K to link",
    ]);
  });

  it("strips bullet markers of every flavour", () => {
    expect(releaseNoteLines("- dash\n* star\n• dot")).toEqual([
      "dash",
      "star",
      "dot",
    ]);
  });

  it("drops headings and the shippable-fallback placeholder", () => {
    const body =
      "## 0.1.61\n\nSee the assets below to download and install this version.\n- A real point";
    expect(releaseNoteLines(body)).toEqual(["A real point"]);
  });

  it("is empty for a missing body", () => {
    expect(releaseNoteLines(null)).toEqual([]);
    expect(releaseNoteLines(undefined)).toEqual([]);
    expect(releaseNoteLines("")).toEqual([]);
  });

  it("reads the real release body end to end", () => {
    expect(releaseNoteLines(notesForVersion(MULTI, "0.1.61"), 5)).toEqual([
      "Baalda now updates itself at a quiet moment.",
      "What's New covers only the version you were given.",
    ]);
  });
});

describe("isSilentRelease", () => {
  it("is silent when the workflow marked the body", () => {
    const body = `See the assets below to download and install this version.\n${SILENT_RELEASE_MARKER}`;
    expect(isSilentRelease(body, "0.1.70")).toBe(true);
  });

  it("is silent when a staging body carries the marker under its warning", () => {
    const body = `**This is a STAGING build.**\n\n- Staging version: x\n\n${SILENT_RELEASE_MARKER}`;
    expect(isSilentRelease(body, "0.1.70-staging.3")).toBe(true);
  });

  it("is silent when there is nothing to list", () => {
    expect(isSilentRelease(null, "0.1.70")).toBe(true);
    expect(isSilentRelease("See the assets below to download and install this version.", "0.1.70")).toBe(true);
  });

  it("announces a release with notes", () => {
    expect(isSilentRelease(MULTI, "0.1.60")).toBe(false);
  });
});
