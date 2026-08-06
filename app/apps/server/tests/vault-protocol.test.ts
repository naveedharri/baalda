import { describe, expect, it } from "vitest";
import {
  parseHello,
  parsePresence,
  encodeWsUpdate,
  decodeWsUpdate,
  encodePubsubUpdate,
  encodePubsubAclChanged,
  encodePubsubRegistryChanged,
  encodePubsubMemberJoined,
  encodePubsubPresence,
  encodePubsubPresenceQuery,
  encodePubsubVoice,
  encodeVoiceFrame,
  decodeVoiceFrame,
  decodePubsub,
  MAX_VOICE_CHUNK_BYTES,
  type VoiceHeader,
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

  it("decodes the registry-changed control payload", () => {
    // `origins` is always present, empty when unattributed — the channel reads
    // `msg.origins.length` unguarded, so the field is part of the contract.
    expect(decodePubsub(encodePubsubRegistryChanged())).toEqual({
      type: "registry-changed",
      origins: [],
    });
  });

  it("round-trips the origin list that drives self-exclusion", () => {
    // A window carrying only our own writes lets the channel skip telling us to
    // re-pull them; one carrying anyone else's must still land. That decision is
    // made entirely from this field.
    expect(decodePubsub(encodePubsubRegistryChanged(["client-a"]))).toEqual({
      type: "registry-changed",
      origins: ["client-a"],
    });
    expect(decodePubsub(encodePubsubRegistryChanged(["client-a", "client-b"]))).toEqual({
      type: "registry-changed",
      origins: ["client-a", "client-b"],
    });
  });

  it("round-trips a member-joined payload with the member's name (incl. unicode)", () => {
    expect(decodePubsub(encodePubsubMemberJoined("Ada Lovelace"))).toEqual({
      type: "member-joined",
      name: "Ada Lovelace",
    });
    expect(decodePubsub(encodePubsubMemberJoined("François 🎉"))).toEqual({
      type: "member-joined",
      name: "François 🎉",
    });
  });

  it("round-trips a presence pubsub payload (incl. a null docId = gone)", () => {
    const p = { userId: "u1", docId: "note-9", name: "Ada 🎉", color: "#6366f1", status: "online" };
    expect(decodePubsub(encodePubsubPresence(p))).toEqual({ type: "presence", presence: p });
    const gone = { userId: "u1", docId: null, name: "", color: "", status: "" };
    expect(decodePubsub(encodePubsubPresence(gone))).toEqual({ type: "presence", presence: gone });
  });

  it("decodes the presence-query control payload", () => {
    expect(decodePubsub(encodePubsubPresenceQuery())).toEqual({ type: "presence-query" });
  });

  it("parses a valid presence frame and rejects malformed ones", () => {
    const ok = parsePresence(
      JSON.stringify({ t: "presence", docId: "d1", name: "Ada", color: "#fff", status: "busy" }),
    );
    expect(ok).toEqual({ t: "presence", docId: "d1", name: "Ada", color: "#fff", status: "busy" });
    // null docId is valid ("not viewing anything")
    expect(
      parsePresence(JSON.stringify({ t: "presence", docId: null, name: "A", color: "c", status: "s" }))
        ?.docId,
    ).toBeNull();
    expect(parsePresence(JSON.stringify({ t: "hello", token: "x", manifest: {} }))).toBeNull();
    expect(parsePresence(JSON.stringify({ t: "presence", name: "A", color: "c" }))).toBeNull(); // no status
    expect(parsePresence("not json")).toBeNull();
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

  it("carries hello caps through, defaulting to undefined and dropping non-strings", () => {
    const withCaps = parseHello(
      JSON.stringify({ t: "hello", token: "t", manifest: {}, caps: ["voice", 7, "x"] }),
    );
    expect(withCaps?.caps).toEqual(["voice", "x"]);
    expect(parseHello(JSON.stringify({ t: "hello", token: "t", manifest: {} }))?.caps).toBeUndefined();
  });
});

describe("voice frame codec", () => {
  it("round-trips a header and its audio payload", () => {
    const audio = new Uint8Array([0, 1, 2, 250, 255]);
    const header: VoiceHeader = { s: "tx1", n: 3, f: 1, fmt: "pcm16", sr: 16000, u: "u1", m: "Ada", c: "#fff" };
    const decoded = decodeVoiceFrame(encodeVoiceFrame(header, audio));
    expect(decoded?.header).toEqual(header);
    expect(decoded?.audio).toEqual(audio);
  });

  it("keeps an empty payload decodable (a bare end-of-transmission marker)", () => {
    const decoded = decodeVoiceFrame(encodeVoiceFrame({ s: "tx1", n: 9, f: 1 }, new Uint8Array()));
    expect(decoded?.header).toEqual({ s: "tx1", n: 9, f: 1 });
    expect(decoded?.audio).toEqual(new Uint8Array());
  });

  it("omits absent optional fields rather than emitting undefined keys", () => {
    const decoded = decodeVoiceFrame(encodeVoiceFrame({ s: "tx1", n: 0 }, new Uint8Array([1])));
    expect(decoded?.header).toEqual({ s: "tx1", n: 0 });
  });

  it("rejects frames that are not voice, are truncated, or lack a usable header", () => {
    expect(decodeVoiceFrame(new Uint8Array())).toBeNull();
    expect(decodeVoiceFrame(new Uint8Array([0xff, 0, 2]))).toBeNull(); // wrong type byte
    expect(decodeVoiceFrame(new Uint8Array([0x01, 0xff, 0xff, 1]))).toBeNull(); // header runs past the end
    expect(decodeVoiceFrame(encodeVoiceFrame({ n: 0 } as unknown as VoiceHeader, new Uint8Array()))).toBeNull();
    expect(decodeVoiceFrame(encodeVoiceFrame({ s: "" } as unknown as VoiceHeader, new Uint8Array()))).toBeNull();
    expect(
      decodeVoiceFrame(encodeVoiceFrame({ s: "tx", n: -1 } as unknown as VoiceHeader, new Uint8Array())),
    ).toBeNull();
    expect(
      decodeVoiceFrame(encodeVoiceFrame({ s: "tx", n: 1.5 } as unknown as VoiceHeader, new Uint8Array())),
    ).toBeNull();
  });

  it("rejects a chunk over the per-chunk cap", () => {
    const ok = encodeVoiceFrame({ s: "tx", n: 0 }, new Uint8Array(MAX_VOICE_CHUNK_BYTES));
    expect(decodeVoiceFrame(ok)).not.toBeNull();
    const tooBig = encodeVoiceFrame({ s: "tx", n: 0 }, new Uint8Array(MAX_VOICE_CHUNK_BYTES + 1));
    expect(decodeVoiceFrame(tooBig)).toBeNull();
  });

  it("round-trips a voice frame through the cross-instance pubsub envelope", () => {
    const frame = encodeVoiceFrame({ s: "tx1", n: 0, u: "ada" }, new Uint8Array([4, 5, 6]));
    const msg = decodePubsub(encodePubsubVoice(frame));
    expect(msg?.type).toBe("voice");
    if (msg?.type !== "voice") throw new Error("expected a voice message");
    expect(msg.speakerId).toBe("ada");
    expect(decodeVoiceFrame(msg.frame)?.audio).toEqual(new Uint8Array([4, 5, 6]));
  });

  it("drops a pubsub voice payload with no speaker stamped on it", () => {
    // Only the relay produces these, and it always stamps `u`; one without it
    // could not be attributed and must not reach a client.
    const unstamped = encodeVoiceFrame({ s: "tx1", n: 0 }, new Uint8Array([1]));
    expect(decodePubsub(encodePubsubVoice(unstamped))).toBeNull();
  });
});
