import { describe, expect, it } from "vitest";
import {
  decodePubsub,
  encodePubsubMessagesChanged,
  PS_MESSAGES_CHANGED,
} from "../src/sync/vault-protocol.js";
import { decodeUserEvent, encodeUserEvent } from "../src/sync/user-events.js";

describe("messages-changed push encoding", () => {
  it("round-trips the fleet-wide pub/sub hint", () => {
    const bytes = encodePubsubMessagesChanged();
    expect(Array.from(bytes)).toEqual([PS_MESSAGES_CHANGED]);
    expect(decodePubsub(bytes)).toEqual({ type: "messages-changed" });
  });

  it("round-trips the user-addressed hint", () => {
    expect(decodeUserEvent(encodeUserEvent({ t: "messages-changed" }))).toEqual({ t: "messages-changed" });
  });
});
