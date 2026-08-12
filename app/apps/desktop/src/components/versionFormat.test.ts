import { describe, expect, it } from "vitest";
import {
  agoFromIso,
  checkpointTitle,
  formatVersionSize,
  lastEditedTooltip,
  nextActiveIndex,
  noteCountLabel,
  parseIsoMs,
  revertToastText,
  versionAuthorLabel,
  versionCauseLabel,
} from "./versionFormat";

// Every helper here renders a row the user is about to act on — reverting a
// note or a whole vault — so the interesting cases are the degenerate ones the
// server is allowed to send: a null author, a version with no size, a
// checkpoint with no label.

const NOW = Date.parse("2026-08-11T12:00:00.000Z");

describe("parseIsoMs / agoFromIso", () => {
  it("reads a server ISO timestamp", () => {
    expect(parseIsoMs("2026-08-11T11:00:00.000Z")).toBe(NOW - 3_600_000);
  });

  it("returns null rather than NaN for junk", () => {
    expect(parseIsoMs("not a date")).toBeNull();
    expect(parseIsoMs(null)).toBeNull();
    expect(parseIsoMs(undefined)).toBeNull();
  });

  it("degrades to a dash instead of 'NaNm ago'", () => {
    expect(agoFromIso("nope", NOW)).toBe("—");
    expect(agoFromIso("2026-08-11T11:00:00.000Z", NOW)).toBe("1h ago");
    expect(agoFromIso("2026-08-11T11:59:50.000Z", NOW)).toBe("just now");
  });
});

describe("versionCauseLabel", () => {
  it("names the pre-revert safety copy distinctly", () => {
    expect(versionCauseLabel("pre-revert")).toBe("Before revert");
  });

  it("treats anything else as the ordinary idle capture", () => {
    expect(versionCauseLabel("idle")).toBe("Auto-saved");
    // A cause added server-side later must not render blank.
    expect(versionCauseLabel("something-new")).toBe("Auto-saved");
  });
});

describe("versionAuthorLabel", () => {
  it("falls back when the author was deleted or never recorded", () => {
    expect(versionAuthorLabel(null)).toBe("Unknown");
    expect(versionAuthorLabel("   ")).toBe("Unknown");
    expect(versionAuthorLabel("Ada")).toBe("Ada");
  });
});

describe("formatVersionSize", () => {
  it("uses bytes, then one decimal of KB/MB, then whole units", () => {
    expect(formatVersionSize(0)).toBe("0 B");
    expect(formatVersionSize(812)).toBe("812 B");
    expect(formatVersionSize(1024)).toBe("1.0 KB");
    expect(formatVersionSize(4198)).toBe("4.1 KB");
    expect(formatVersionSize(1024 * 200)).toBe("200 KB");
    expect(formatVersionSize(1024 * 1024 * 1.25)).toBe("1.3 MB");
  });

  it("renders nothing for a size the server didn't send", () => {
    expect(formatVersionSize(Number.NaN)).toBe("");
    expect(formatVersionSize(-1)).toBe("");
  });
});

describe("nextActiveIndex", () => {
  it("wraps in both directions", () => {
    expect(nextActiveIndex("ArrowDown", 2, 3)).toBe(0);
    expect(nextActiveIndex("ArrowUp", 0, 3)).toBe(2);
    expect(nextActiveIndex("ArrowDown", 0, 3)).toBe(1);
  });

  it("jumps to the ends", () => {
    expect(nextActiveIndex("Home", 2, 3)).toBe(0);
    expect(nextActiveIndex("End", 0, 3)).toBe(2);
  });

  it("declines keys it doesn't own, so they aren't swallowed", () => {
    expect(nextActiveIndex("Enter", 0, 3)).toBeNull();
    expect(nextActiveIndex("a", 0, 3)).toBeNull();
  });

  it("declines everything when there are no rows", () => {
    expect(nextActiveIndex("ArrowDown", 0, 0)).toBeNull();
  });
});

describe("revertToastText", () => {
  it("says which version landed", () => {
    expect(revertToastText("2026-08-11T09:00:00.000Z", NOW)).toBe(
      "Reverted to the version from 3h ago",
    );
  });
});

describe("lastEditedTooltip", () => {
  it("accepts either a timestamp or an ISO string", () => {
    expect(lastEditedTooltip("Ada", NOW - 120_000, NOW)).toBe("Edited by Ada · 2m ago");
    expect(lastEditedTooltip("Ada", "2026-08-11T11:58:00.000Z", NOW)).toBe(
      "Edited by Ada · 2m ago",
    );
  });

  it("drops the time when there isn't one, and names an unknown editor", () => {
    expect(lastEditedTooltip("Ada", null, NOW)).toBe("Edited by Ada");
    expect(lastEditedTooltip(null, NOW, NOW)).toBe("Edited by Someone · just now");
  });
});

describe("checkpointTitle", () => {
  it("prefers the user's own label", () => {
    expect(checkpointTitle("Before the big refactor", "manual", "", NOW)).toBe(
      "Before the big refactor",
    );
  });

  it("describes an unlabelled checkpoint by kind and age", () => {
    expect(checkpointTitle(null, "auto", "2026-08-10T12:00:00.000Z", NOW)).toBe(
      "Daily checkpoint · 1d ago",
    );
    expect(checkpointTitle("  ", "manual", "2026-08-11T11:00:00.000Z", NOW)).toBe(
      "Manual checkpoint · 1h ago",
    );
  });
});

describe("noteCountLabel", () => {
  it("pluralises", () => {
    expect(noteCountLabel(1)).toBe("1 note");
    expect(noteCountLabel(0)).toBe("0 notes");
    expect(noteCountLabel(12)).toBe("12 notes");
  });
});
