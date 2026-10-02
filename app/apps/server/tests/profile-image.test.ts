import { describe, expect, it } from "vitest";
import { isValidProfileImage, PROFILE_IMAGE_MAX_CHARS } from "../src/auth/profile-image.js";

describe("isValidProfileImage", () => {
  it("accepts clearing, characters, uploads and provider photos", () => {
    expect(isValidProfileImage(null)).toBe(true);
    expect(isValidProfileImage(undefined)).toBe(true);
    expect(isValidProfileImage("character:baalda-7")).toBe(true);
    expect(isValidProfileImage("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
    expect(isValidProfileImage("https://lh3.googleusercontent.com/a/abc=s96-c")).toBe(true);
  });

  it("refuses anything else", () => {
    expect(isValidProfileImage("javascript:alert(1)")).toBe(false);
    expect(isValidProfileImage("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false);
    expect(isValidProfileImage("character:")).toBe(false);
    expect(isValidProfileImage(7)).toBe(false);
    expect(isValidProfileImage("data:image/png;base64," + "A".repeat(PROFILE_IMAGE_MAX_CHARS))).toBe(false);
  });
});
