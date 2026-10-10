import { describe, expect, it } from "vitest";
import { InMemoryPubSub } from "../src/sync/pubsub.js";
import {
  decodeUserEvent,
  encodeUserEvent,
  publishUserEvent,
  type UserEvent,
  userTopic,
} from "../src/sync/user-events.js";

const invite: UserEvent = {
  t: "invitation",
  invitationId: "inv-1",
  orgId: "org-b",
  orgName: "Design",
  inviterName: "Sam",
  role: "member",
};

describe("user-addressed events", () => {
  it("reach every connection of that user, across vaults, and no one else", async () => {
    const pubsub = new InMemoryPubSub();
    const got: Record<string, UserEvent[]> = { aVault1: [], aVault2: [], other: [] };
    // Two channels of user A (different vaults / devices) and one of user B.
    const sub = (key: string, userId: string) =>
      pubsub.subscribe(userTopic(userId), (p) => {
        const e = decodeUserEvent(p);
        if (e) got[key].push(e);
      });
    await sub("aVault1", "user-a");
    const offA2 = await sub("aVault2", "user-a");
    await sub("other", "user-b");

    await publishUserEvent(pubsub, "user-a", invite);
    expect(got.aVault1).toEqual([invite]);
    expect(got.aVault2).toEqual([invite]);
    expect(got.other).toEqual([]);

    // A closed connection stops hearing; the gone frame reaches the rest.
    offA2();
    await publishUserEvent(pubsub, "user-a", { t: "invitation-gone", invitationId: "inv-1" });
    expect(got.aVault1.at(-1)).toEqual({ t: "invitation-gone", invitationId: "inv-1" });
    expect(got.aVault2).toHaveLength(1);
  });

  it("round-trips and rejects garbage", () => {
    expect(decodeUserEvent(encodeUserEvent(invite))).toEqual(invite);
    expect(decodeUserEvent(new TextEncoder().encode("not json"))).toBeNull();
    expect(decodeUserEvent(new TextEncoder().encode('{"t":"invitation"}'))).toBeNull();
    expect(decodeUserEvent(new TextEncoder().encode('{"t":"update","docId":"x"}'))).toBeNull();
  });
});
