import { describe, expect, it } from "vitest";
import { accessLevelClass, audienceLine, myAccessOf, personAccessOptions } from "../access";

const aud = (count: number, total: number) => ({ everyone: count === total, count, total, people: [] });

describe("skill access helpers", () => {
  it("says who has a skill in a few words", () => {
    expect(audienceLine(aud(6, 6), true)).toBe("Everyone · 6");
    expect(audienceLine(aud(0, 6), false)).toBe("Nobody yet");
    expect(audienceLine(aud(1, 6), true)).toBe("Only you");
    expect(audienceLine(aud(2, 6), true)).toBe("You and 1 other");
    expect(audienceLine(aud(3, 6), true)).toBe("You and 2 others");
    expect(audienceLine(aud(3, 6), false)).toBe("3 people");
    expect(audienceLine(aud(1, 6), false)).toBe("1 person");
  });

  it("falls back to the delivery on a server without per-person access", () => {
    expect(myAccessOf({ delivery: "optional" })).toBe("optional");
    expect(myAccessOf({ delivery: "required", myAccess: "none" })).toBe("none");
  });

  it("offers Same as everyone only to someone with their own setting, naming the level", () => {
    expect(personAccessOptions(false, "required").map((o) => o.value)).toEqual(["required", "optional", "none"]);
    const own = personAccessOptions(true, "optional");
    expect(own.at(-1)).toMatchObject({ value: "everyone", label: "Same as everyone (Optional)" });
  });

  it("colours levels like vault access", () => {
    expect([accessLevelClass("required"), accessLevelClass("optional"), accessLevelClass("none")]).toEqual(["is-edit", "is-view", "is-none"]);
  });
});
