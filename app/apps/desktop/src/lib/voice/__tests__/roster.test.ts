import { describe, expect, it } from "vitest";
import { VoiceRoster } from "../roster";

// The data behind the "someone is talking" micro-interaction: the receiving
// animation and the speaker label both read off this, so a regression here is
// a silent broadcast — audio with no indication of who it's from.

describe("VoiceRoster", () => {
  it("is empty and inactive until someone talks", () => {
    const r = new VoiceRoster();
    expect(r.list()).toEqual([]);
    expect(r.active).toBe(false);
  });

  it("goes active the moment a speaker starts, which is what shakes the button", () => {
    const r = new VoiceRoster();
    r.learn("ada", "Ada Lovelace", "#6366f1");
    expect(r.setSpeaking("ada", true)).toBe(true);

    expect(r.active).toBe(true);
    expect(r.list()).toEqual([{ userId: "ada", name: "Ada Lovelace", color: "#6366f1" }]);
  });

  it("keeps the label for the rest of the stream, since only chunk 0 carries it", () => {
    const r = new VoiceRoster();
    r.learn("ada", "Ada Lovelace", "#6366f1"); // opening chunk
    r.setSpeaking("ada", true);
    r.learn("ada", undefined, undefined); // every later chunk carries nothing

    expect(r.list()[0].name).toBe("Ada Lovelace");
    expect(r.list()[0].color).toBe("#6366f1");
  });

  it("falls back to a readable placeholder rather than showing a raw user id", () => {
    const r = new VoiceRoster((id) => `color-${id}`);
    r.setSpeaking("u-42", true);

    expect(r.list()).toEqual([{ userId: "u-42", name: "Someone", color: "color-u-42" }]);
  });

  it("reports no change on repeat signals, so playback doesn't re-render per chunk", () => {
    const r = new VoiceRoster();
    expect(r.setSpeaking("ada", true)).toBe(true);
    expect(r.setSpeaking("ada", true)).toBe(false);
    expect(r.setSpeaking("ada", false)).toBe(true);
    expect(r.setSpeaking("ada", false)).toBe(false);
  });

  it("tracks two teammates talking at once and clears them independently", () => {
    const r = new VoiceRoster();
    r.learn("ada", "Ada", "#111");
    r.learn("grace", "Grace", "#222");
    r.setSpeaking("ada", true);
    r.setSpeaking("grace", true);

    expect(r.list().map((s) => s.name).sort()).toEqual(["Ada", "Grace"]);

    r.setSpeaking("ada", false);
    expect(r.list()).toEqual([{ userId: "grace", name: "Grace", color: "#222" }]);
    expect(r.active).toBe(true); // Grace is still going

    r.setSpeaking("grace", false);
    expect(r.active).toBe(false);
  });

  it("goes inactive once the last speaker stops, so the animation ends", () => {
    const r = new VoiceRoster();
    r.setSpeaking("ada", true);
    r.setSpeaking("ada", false);

    expect(r.active).toBe(false);
    expect(r.list()).toEqual([]);
  });

  it("merges a partial label without wiping what it already knew", () => {
    const r = new VoiceRoster();
    r.learn("ada", "Ada", "#111");
    r.learn("ada", "Ada Lovelace"); // name only — colour must survive
    r.setSpeaking("ada", true);

    expect(r.list()[0]).toEqual({ userId: "ada", name: "Ada Lovelace", color: "#111" });
  });

  it("forgets everything on clear, so audio can't leak across a vault switch", () => {
    const r = new VoiceRoster();
    r.learn("ada", "Ada", "#111");
    r.setSpeaking("ada", true);
    r.clear();

    expect(r.active).toBe(false);
    expect(r.list()).toEqual([]);
    // The label is gone too, not just the speaking flag.
    r.setSpeaking("ada", true);
    expect(r.list()[0].name).toBe("Someone");
  });
});
