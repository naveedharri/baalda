import { describe, expect, it } from "vitest";
import {
  PS_SKILLS_CHANGED,
  decodePubsub,
  encodePubsubSkillsChanged,
} from "../src/sync/vault-protocol.js";

// Pure framing for the `skills-changed` pubsub message (docs/SKILLS.md §3.4).

describe("skills-changed pubsub framing", () => {
  it("round-trips the org id", () => {
    const bytes = encodePubsubSkillsChanged("org-1");
    expect(bytes[0]).toBe(PS_SKILLS_CHANGED);
    expect(PS_SKILLS_CHANGED).toBe(0x0f);
    expect(decodePubsub(bytes)).toEqual({ type: "skills-changed", orgId: "org-1" });
  });

  it("decodes bad JSON or a missing org id to null", () => {
    const junk = new Uint8Array([PS_SKILLS_CHANGED, 0x7b, 0x7b]);
    expect(decodePubsub(junk)).toBeNull();
    const noOrg = new Uint8Array([PS_SKILLS_CHANGED, ...new TextEncoder().encode('{"x":1}')]);
    expect(decodePubsub(noOrg)).toBeNull();
    const nullBody = new Uint8Array([PS_SKILLS_CHANGED, ...new TextEncoder().encode("null")]);
    expect(decodePubsub(nullBody)).toBeNull();
  });
});
