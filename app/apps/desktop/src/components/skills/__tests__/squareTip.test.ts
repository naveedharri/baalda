import { describe, expect, it } from "vitest";
import { requiredTip, tipFromTitle, tipText } from "../SquareTip";

describe("install square tips", () => {
  it("a title's first line is the heading, the rest are lines", () => {
    expect(tipFromTitle("On this computer · click to remove\nClaude: Installed v1\nOther tools: Off")).toEqual({
      heading: "On this computer · click to remove",
      lines: ["Claude: Installed v1", "Other tools: Off"],
    });
    expect(tipFromTitle("Use on this computer")).toEqual({ heading: "Use on this computer", lines: [] });
  });

  it("Required says why it can't be removed, and where admins change it", () => {
    const member = requiredTip(["Claude: Installed v1"], false);
    expect(member.heading).toBe("Required by your team");
    expect(member.body).toBe("It's always installed on everyone's computer and can't be removed.");
    expect(member.note).toBeUndefined();
    expect(requiredTip([], true).note).toBe("Change it to Optional on the skill's page.");
    expect(tipText(member)).toBe(
      "Required by your team. It's always installed on everyone's computer and can't be removed. Claude: Installed v1",
    );
  });
});
