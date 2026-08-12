import { describe, expect, it } from "vitest";
import { releaseNoteLines } from "../updater";

// The post-update banner's one-liners come straight from the GitHub release
// body (docs/RELEASE_NOTES.md at ship time). These lock in the cleanup rules:
// bullets lose their markers, headings/blanks/the legacy placeholder vanish,
// and a long list is capped rather than scrolling the banner.
describe("releaseNoteLines", () => {
  it("strips bullet markers and drops headings and blank lines", () => {
    const body = [
      "# v0.2.0",
      "",
      "- Version history for every note",
      "* Vault checkpoints",
      "• Sync indicator",
      "plain line stays",
      "",
    ].join("\n");
    expect(releaseNoteLines(body)).toEqual([
      "Version history for every note",
      "Vault checkpoints",
      "Sync indicator",
      "plain line stays",
    ]);
  });

  it("drops the legacy placeholder body entirely", () => {
    expect(
      releaseNoteLines("See the assets below to download and install this version."),
    ).toEqual([]);
  });

  it("caps the list and tolerates null/undefined", () => {
    const body = Array.from({ length: 10 }, (_, i) => `- line ${i}`).join("\n");
    expect(releaseNoteLines(body, 6)).toHaveLength(6);
    expect(releaseNoteLines(null)).toEqual([]);
    expect(releaseNoteLines(undefined)).toEqual([]);
  });
});
