import { describe, expect, it } from "vitest";
import { githubTokenKey } from "../github";

describe("githubTokenKey", () => {
  it("is per server (trailing slashes ignored) and per vault", () => {
    expect(githubTokenKey(" https://api.test/ ", "org-1")).toBe("baalda.skills.github:https://api.test|org-1");
    expect(githubTokenKey("https://api.test", "org-2")).not.toBe(githubTokenKey("https://api.test", "org-1"));
  });
});
