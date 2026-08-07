import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoicePlayer } from "../playback";
import { floatToPcm16 } from "../pcm";

// A fake AudioContext just real enough to assert scheduling. What matters here
// is WHEN each buffer is started relative to the last — that's what makes a
// stream gapless instead of chopped — so the fake records start times.

interface Started {
  at: number;
  duration: number;
}

class FakeSource {
  onended: (() => void) | null = null;
  buffer: { duration: number } | null = null;
  stopped = false;
  constructor(private readonly log: Started[]) {}
  connect(): void {}
  start(at: number): void {
    this.log.push({ at, duration: this.buffer?.duration ?? 0 });
  }
  stop(): void {
    this.stopped = true;
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state = "running";
  currentTime = 0;
  readonly started: Started[] = [];
  readonly sources: FakeSource[] = [];
  destination = {};
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  resume(): Promise<void> {
    this.state = "running";
    return Promise.resolve();
  }
  createBuffer(_ch: number, length: number, sampleRate: number) {
    const data = new Float32Array(length);
    return {
      duration: length / sampleRate,
      length,
      sampleRate,
      copyToChannel: (src: Float32Array) => data.set(src),
    };
  }
  createBufferSource() {
    const s = new FakeSource(this.started);
    this.sources.push(s);
    return s;
  }
}

/** 100 ms of 16 kHz PCM16 = 1600 samples. */
function pcmChunk(ms = 100): Uint8Array {
  return floatToPcm16(new Float32Array((16_000 * ms) / 1000).fill(0.25));
}

const ctxOf = () => FakeAudioContext.instances[0];

beforeEach(() => {
  FakeAudioContext.instances = [];
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("VoicePlayer", () => {
  it("schedules consecutive chunks back-to-back with no gap", () => {
    const player = new VoicePlayer();
    for (let n = 0; n < 3; n++) {
      player.push({ streamId: "tx", userId: "ada", seq: n, audio: pcmChunk(100), sampleRate: 16_000 });
    }

    const started = ctxOf().started;
    expect(started).toHaveLength(3);
    // Each chunk begins exactly where the previous one ended — that equality is
    // the whole point; any slack here is an audible click between chunks.
    expect(started[1].at).toBeCloseTo(started[0].at + started[0].duration, 6);
    expect(started[2].at).toBeCloseTo(started[1].at + started[1].duration, 6);
    expect(started[0].duration).toBeCloseTo(0.1, 6);
  });

  it("starts slightly ahead of now so jitter has somewhere to absorb", () => {
    const player = new VoicePlayer();
    player.push({ streamId: "tx", userId: "ada", seq: 0, audio: pcmChunk() });
    expect(ctxOf().started[0].at).toBeGreaterThan(ctxOf().currentTime);
  });

  it("re-anchors to the present when the stream has drifted too far ahead", () => {
    const player = new VoicePlayer();
    // A burst far longer than the drift ceiling: a listener who fell behind must
    // skip forward rather than keep sliding further behind for the whole
    // transmission.
    for (let n = 0; n < 30; n++) {
      player.push({ streamId: "tx", userId: "ada", seq: n, audio: pcmChunk(100) });
    }
    const started = ctxOf().started;
    const last = started[started.length - 1].at;
    expect(last - ctxOf().currentTime).toBeLessThanOrEqual(1.0 + 0.2 + 1e-6);
  });

  it("never schedules in the past after the context clock advances", () => {
    const player = new VoicePlayer();
    player.push({ streamId: "tx", userId: "ada", seq: 0, audio: pcmChunk() });
    // Time moves on while the next chunk is in flight (a stall).
    ctxOf().currentTime = 10;
    player.push({ streamId: "tx", userId: "ada", seq: 1, audio: pcmChunk() });

    const at = ctxOf().started[1].at;
    expect(at).toBeGreaterThanOrEqual(10);
  });

  it("holds an out-of-order chunk and plays it in sequence", () => {
    const player = new VoicePlayer();
    player.push({ streamId: "tx", userId: "ada", seq: 1, audio: pcmChunk(50) });
    expect(ctxOf().started).toHaveLength(0); // waiting on seq 0
    player.push({ streamId: "tx", userId: "ada", seq: 0, audio: pcmChunk(100) });

    const started = ctxOf().started;
    expect(started).toHaveLength(2);
    expect(started[0].duration).toBeCloseTo(0.1, 6); // seq 0 first
    expect(started[1].duration).toBeCloseTo(0.05, 6);
  });

  it("mixes two teammates talking at once as independent streams", () => {
    const player = new VoicePlayer();
    player.push({ streamId: "a", userId: "ada", seq: 0, audio: pcmChunk() });
    player.push({ streamId: "b", userId: "grace", seq: 0, audio: pcmChunk() });

    // Both scheduled; neither cut the other off.
    expect(ctxOf().started).toHaveLength(2);
    expect(player.isPlaying()).toBe(true);
  });

  it("reports speaking start immediately and end only once the audio finishes", () => {
    const events: Array<[string, boolean]> = [];
    const player = new VoicePlayer({ onSpeakingChange: (u, s) => events.push([u, s]) });

    player.push({ streamId: "tx", userId: "ada", seq: 0, audio: pcmChunk(100) });
    expect(events).toEqual([["ada", true]]);

    player.push({ streamId: "tx", userId: "ada", seq: 1, audio: pcmChunk(100), final: true });
    // Still "talking": the buffered audio hasn't played out yet.
    expect(events).toEqual([["ada", true]]);

    vi.advanceTimersByTime(2000);
    expect(events).toEqual([
      ["ada", true],
      ["ada", false],
    ]);
    expect(player.isPlaying()).toBe(false);
  });

  it("flushes a held chunk when the transmission ends rather than binning it", () => {
    const player = new VoicePlayer();
    // seq 0 is lost; seq 1 arrives and is held, then the sender releases.
    player.push({ streamId: "tx", userId: "ada", seq: 1, audio: pcmChunk(), final: true });
    expect(ctxOf().started).toHaveLength(1);
  });

  it("stops and forgets everything on stopAll", () => {
    const player = new VoicePlayer();
    player.push({ streamId: "tx", userId: "ada", seq: 0, audio: pcmChunk() });
    player.stopAll();

    expect(player.isPlaying()).toBe(false);
    expect(ctxOf().sources.every((s) => s.stopped)).toBe(true);
  });

  it("degrades to silence when the platform gives us no AudioContext", () => {
    vi.stubGlobal("AudioContext", function Broken() {
      throw new Error("no audio device");
    });
    const player = new VoicePlayer();
    expect(() =>
      player.push({ streamId: "tx", userId: "ada", seq: 0, audio: pcmChunk() }),
    ).not.toThrow();
    expect(player.isPlaying()).toBe(false);
  });

  it("resumes a suspended context, since a receiver gets no user gesture", () => {
    const player = new VoicePlayer();
    FakeAudioContext.prototype.state = "suspended";
    player.push({ streamId: "tx", userId: "ada", seq: 0, audio: pcmChunk() });
    expect(ctxOf().state).toBe("running");
    FakeAudioContext.prototype.state = "running";
  });
});
