import { describe, expect, it } from "vitest";
import {
  parseHello,
  encodeWsUpdate,
  decodeWsUpdate,
  encodePubsubUpdate,
  encodePubsubAclChanged,
  decodePubsub,
} from "../src/sync/vault-protocol.js";

// Pure framing round-trips (spec 05 §3.1) — no socket, DB, or Redis.

describe("vault channel framing", () => {
  it("round-trips a WS update frame with a binary payload", () => {
    const update = new Uint8Array([0, 255, 12, 99]);
    const frame = encodeWsUpdate("note-abc", update);
    const out = decodeWsUpdate(frame);
    expect(out?.docId).toBe("note-abc");
    expect([...(out?.update ?? [])]).toEqual([0, 255, 12, 99]);
  });

  it("round-trips a pubsub update frame under the 0x01 type byte", () => {
    const update = new Uint8Array([7, 7, 7]);
    const msg = decodePubsub(encodePubsubUpdate("d1", update));
    expect(msg).toEqual({ type: "update", docId: "d1", update: new Uint8Array([7, 7, 7]) });
  });

  it("decodes the acl-changed control payload", () => {
    expect(decodePubsub(encodePubsubAclChanged())).toEqual({ type: "acl-changed" });
  });

  it("returns null for a truncated frame and an unknown pubsub type", () => {
    expect(decodeWsUpdate(new Uint8Array([0]))).toBeNull(); // too short for length prefix
    expect(decodePubsub(new Uint8Array([0xff]))).toBeNull(); // unknown type byte
    expect(decodePubsub(new Uint8Array())).toBeNull();
  });

  it("parses a valid hello and rejects malformed ones", () => {
    const ok = parseHello(JSON.stringify({ t: "hello", token: "tok", manifest: { a: "AAA" } }));
    expect(ok?.token).toBe("tok");
    expect(ok?.manifest).toEqual({ a: "AAA" });
    expect(parseHello("not json")).toBeNull();
    expect(parseHello(JSON.stringify({ t: "nope", token: "x", manifest: {} }))).toBeNull();
    expect(parseHello(JSON.stringify({ t: "hello", manifest: {} }))).toBeNull(); // no token
  });
});
