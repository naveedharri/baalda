import { describe, expect, it } from "vitest";
import {
  ChunkOrderer,
  downsampleTo16k,
  floatToPcm16,
  pcm16ToFloat,
  VOICE_CHUNK_MS,
  VOICE_CHUNK_SAMPLES,
  VOICE_SAMPLE_RATE,
} from "../pcm";

describe("pcm16 conversion", () => {
  it("round-trips a signal within one quantization step", () => {
    const input = new Float32Array(256);
    for (let i = 0; i < input.length; i++) input[i] = Math.sin((i / 256) * Math.PI * 4) * 0.8;

    const back = pcm16ToFloat(floatToPcm16(input));
    expect(back).toHaveLength(input.length);
    for (let i = 0; i < input.length; i++) expect(Math.abs(back[i] - input[i])).toBeLessThan(1 / 32767);
  });

  it("holds the rails exactly at full scale", () => {
    const bytes = floatToPcm16(new Float32Array([1, -1, 0]));
    const view = new DataView(bytes.buffer);
    expect(view.getInt16(0, true)).toBe(32767);
    expect(view.getInt16(2, true)).toBe(-32768);
    expect(view.getInt16(4, true)).toBe(0);
  });

  it("clips out-of-range samples instead of letting them wrap", () => {
    // Unclamped, +1.5 casts to a NEGATIVE Int16 — a loud syllable would come out
    // as a burst of noise rather than as distortion.
    const view = new DataView(floatToPcm16(new Float32Array([1.5, -2.3])).buffer);
    expect(view.getInt16(0, true)).toBe(32767);
    expect(view.getInt16(2, true)).toBe(-32768);
  });

  it("ignores a trailing odd byte rather than reading past the buffer", () => {
    expect(pcm16ToFloat(new Uint8Array([0, 0, 0]))).toHaveLength(1);
    expect(pcm16ToFloat(new Uint8Array())).toHaveLength(0);
  });

  it("decodes correctly when the payload is a view into a larger buffer", () => {
    // Frames arrive as subarrays of a socket buffer, so a byteOffset-aware
    // DataView is the difference between audio and garbage.
    const backing = new Uint8Array([0xff, 0xff, 0x00, 0x40, 0x00, 0x80]);
    const slice = backing.subarray(2); // Int16 LE: 0x4000 = 16384, 0x8000 = -32768
    const out = pcm16ToFloat(slice);
    expect(out).toHaveLength(2);
    expect(out[0]).toBeCloseTo(16384 / 32767, 5);
    expect(out[1]).toBeCloseTo(-1, 5);
  });
});

describe("downsampleTo16k", () => {
  it("returns the input untouched when already at the target rate", () => {
    const input = new Float32Array([0.1, 0.2, 0.3]);
    expect(downsampleTo16k(input, VOICE_SAMPLE_RATE)).toBe(input);
  });

  it("halves the sample count coming from 32 kHz", () => {
    const input = new Float32Array(640);
    expect(downsampleTo16k(input, 32_000)).toHaveLength(320);
  });

  it("produces one chunk's worth of samples from a 48 kHz render quantum run", () => {
    // 48 kHz is what WebAudio hands us on most machines. Derive the input
    // length from VOICE_CHUNK_MS so retuning the chunk size for latency
    // doesn't turn this into a failure about nothing.
    const input = new Float32Array((48_000 * VOICE_CHUNK_MS) / 1000);
    expect(downsampleTo16k(input, 48_000)).toHaveLength(VOICE_CHUNK_SAMPLES);
  });

  it("preserves a constant signal's amplitude", () => {
    const input = new Float32Array(480).fill(0.5);
    for (const s of downsampleTo16k(input, 48_000)) expect(s).toBeCloseTo(0.5, 5);
  });

  it("leaves audio alone when the source rate is already below the target", () => {
    const input = new Float32Array([0.1, 0.2]);
    expect(downsampleTo16k(input, 8_000)).toBe(input);
  });

  it("handles empty input", () => {
    expect(downsampleTo16k(new Float32Array(), 48_000)).toHaveLength(0);
  });
});

describe("ChunkOrderer", () => {
  const chunk = (n: number) => new Uint8Array([n]);
  const seqOf = (out: Uint8Array[]) => out.map((c) => c[0]);

  it("passes in-order chunks straight through", () => {
    const o = new ChunkOrderer();
    expect(seqOf(o.push(0, chunk(0)))).toEqual([0]);
    expect(seqOf(o.push(1, chunk(1)))).toEqual([1]);
    expect(seqOf(o.push(2, chunk(2)))).toEqual([2]);
  });

  it("holds an early arrival until its predecessor lands, then releases both", () => {
    const o = new ChunkOrderer();
    expect(seqOf(o.push(1, chunk(1)))).toEqual([]); // waiting on 0
    expect(seqOf(o.push(0, chunk(0)))).toEqual([0, 1]);
  });

  it("gives up on a lost chunk once enough has stacked up behind it", () => {
    // Chunk 0 never arrives. Playback must continue rather than stall forever.
    const o = new ChunkOrderer(3);
    expect(seqOf(o.push(1, chunk(1)))).toEqual([]);
    expect(seqOf(o.push(2, chunk(2)))).toEqual([]);
    expect(seqOf(o.push(3, chunk(3)))).toEqual([]);
    expect(seqOf(o.push(4, chunk(4)))).toEqual([1, 2, 3, 4]);
  });

  it("discards a chunk that arrives after playback has moved past it", () => {
    const o = new ChunkOrderer();
    o.push(0, chunk(0));
    o.push(1, chunk(1));
    expect(seqOf(o.push(0, chunk(9)))).toEqual([]); // stale duplicate
  });

  it("releases everything still held on flush, in sequence order", () => {
    const o = new ChunkOrderer();
    o.push(3, chunk(3));
    o.push(1, chunk(1));
    o.push(2, chunk(2));
    // 0 was lost and the tolerance was never reached — end of transmission
    // should still play what we have rather than silently bin it.
    expect(seqOf(o.flush())).toEqual([1, 2, 3]);
    expect(o.flush()).toEqual([]);
  });
});
