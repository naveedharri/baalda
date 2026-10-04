import { describe, expect, it, vi } from "vitest";
import {
  MEMBER_PICTURES_INTERVAL_MS,
  createMemberPicturesLoader,
  type MemberPicturesInput,
} from "../lib/memberPictures";

const open: MemberPicturesInput = {
  synced: true,
  serverUrl: "https://api.example.test",
  userId: "u1",
  orgId: "org1",
};

function setup() {
  let t = 1_000_000;
  const fetch = vi.fn(async (_orgId: string) => ({}));
  const load = createMemberPicturesLoader({ fetch, now: () => t });
  return { load, fetch, advance: (ms: number) => (t += ms) };
}

describe("member pictures background load", () => {
  it("asks once when a synced vault opens", () => {
    const { load, fetch } = setup();
    expect(load(open)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("org1");
  });

  it("never asks for a local-only vault or when signed out", () => {
    const { load, fetch } = setup();
    expect(load({ ...open, synced: false })).toBe(false);
    expect(load({ ...open, userId: null })).toBe(false);
    expect(load({ ...open, orgId: null })).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not refetch inside the interval (reconnects, re-renders, re-opens)", () => {
    const { load, fetch, advance } = setup();
    load(open);
    for (let i = 0; i < 20; i++) {
      advance(1_000);
      expect(load(open)).toBe(false);
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("asks again once the interval has passed", () => {
    const { load, fetch, advance } = setup();
    load(open);
    advance(MEMBER_PICTURES_INTERVAL_MS);
    expect(load(open)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("asks at once for a different vault, account or server", () => {
    const { load, fetch } = setup();
    load(open);
    expect(load({ ...open, orgId: "org2" })).toBe(true);
    expect(load({ ...open, userId: "u2" })).toBe(true);
    expect(load({ ...open, serverUrl: "http://localhost:3010" })).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("swallows a failed request and does not retry it inside the interval", async () => {
    let t = 0;
    const fetch = vi.fn(async () => {
      throw new Error("offline");
    });
    const load = createMemberPicturesLoader({ fetch, now: () => t });
    expect(load(open)).toBe(true);
    await Promise.resolve();
    t += 5_000;
    expect(load(open)).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
