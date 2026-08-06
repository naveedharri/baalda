// Pure audio maths for push-to-talk. No WebAudio, no DOM — so the parts that
// are easy to get subtly wrong (resampling, clipping, chunk ordering) are unit
// tested in Node, and the WebAudio glue around them stays thin enough to read.
//
// WHY RAW PCM16 AND NOT OPUS
//
// The obvious instinct is "encode to Opus, it's 10x smaller". We deliberately
// don't, for v1:
//
//   * `MediaRecorder` with a timeslice is the usual suggestion and is a trap
//     here: only the FIRST chunk carries the container header, so later WebM/MP4
//     chunks aren't independently decodable. Making that work needs MediaSource
//     on the receiver, whose support across WKWebView / WebView2 / WebKitGTK is
//     exactly the kind of per-platform lottery this feature can't afford.
//   * A wasm Opus encoder (opus-recorder and friends) means a few hundred KB of
//     dependency and a build step, against a brief that says "very light".
//   * WebCodecs `AudioEncoder` would be ideal — native Opus, per-frame
//     decodable, no dependency — but its availability in WKWebView is the one
//     thing that would strand macOS users.
//
// PCM16 has none of those problems: every frame is independently decodable by
// construction, there is no container, no codec, no dependency, and the
// receiver skips decoding entirely (it fills an AudioBuffer directly). The cost
// is bandwidth — 32 KB/s at the settings below, which for a handful of
// teammates on broadband is unremarkable, and it stays far inside the vault
// channel's existing 4 MB per-connection outbound budget.
//
// The wire header carries `fmt`, so a later Opus path can be added without a
// protocol change: new senders set `fmt:"opus"`, receivers branch on it.

/** Sample rate we transmit at. Speech is intelligible well below this; 16 kHz
 *  is the usual wideband-voice floor and halves the bytes of 32 kHz. */
export const VOICE_SAMPLE_RATE = 16_000;

/** How much audio goes in one chunk. The tradeoff is latency vs overhead:
 *  200 ms means ~5 frames/s (~6.4 KB each) and about a fifth of a second of
 *  mouth-to-ear delay from chunking alone, which reads as "instant" for a
 *  walkie-talkie without making the header overhead significant. */
export const VOICE_CHUNK_MS = 200;

/** Samples per chunk at the transmit rate. */
export const VOICE_CHUNK_SAMPLES = (VOICE_SAMPLE_RATE * VOICE_CHUNK_MS) / 1000;

/**
 * Downsample mono Float32 audio to {@link VOICE_SAMPLE_RATE} by linear
 * interpolation.
 *
 * Linear rather than a windowed-sinc filter is a real, bounded compromise: it
 * doesn't fully suppress aliasing above the new Nyquist, which on speech is
 * mild and on music would be audible. For a walkie-talkie carrying a voice it
 * is the right amount of machinery — a proper polyphase resampler is a lot of
 * code to make "hold to talk" imperceptibly cleaner.
 *
 * Returns the input untouched when the rates already match.
 */
export function downsampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === VOICE_SAMPLE_RATE || input.length === 0) return input;
  if (inputRate < VOICE_SAMPLE_RATE) return input; // already narrower; don't invent detail
  const ratio = inputRate / VOICE_SAMPLE_RATE;
  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, input.length - 1);
    const frac = pos - lo;
    out[i] = input[lo] * (1 - frac) + input[hi] * frac;
  }
  return out;
}

/**
 * Float32 [-1, 1] to little-endian Int16 PCM.
 *
 * Clamps before scaling. Without the clamp a sample even slightly outside the
 * nominal range — which WebAudio does produce — wraps around in the Int16 cast
 * and turns a loud syllable into a burst of noise rather than clipping.
 */
export function floatToPcm16(input: Float32Array): Uint8Array {
  const out = new Uint8Array(input.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    // Asymmetric scaling: Int16 runs -32768..32767, so the two signs differ.
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

/** Little-endian Int16 PCM back to Float32 [-1, 1] for playback. */
export function pcm16ToFloat(bytes: Uint8Array): Float32Array {
  const samples = bytes.length >> 1; // a trailing odd byte can't form a sample
  const out = new Float32Array(samples);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < samples; i++) {
    const v = view.getInt16(i * 2, true);
    out[i] = v < 0 ? v / 0x8000 : v / 0x7fff;
  }
  return out;
}

/**
 * Reorders the chunks of one transmission and reports when each is playable.
 *
 * The vault relay preserves order per socket, so out-of-order arrival is not the
 * common case — but a chunk can be dropped (rate budget, a listener at its
 * outbound bound), and playback must survive a gap rather than stall on it. So
 * this holds a chunk only briefly for a missing predecessor, then gives up on it
 * and moves on: in live audio a late packet is indistinguishable from a lost
 * one, and waiting turns one dropped chunk into a growing delay for everything
 * after it.
 */
export class ChunkOrderer {
  private next = 0;
  private readonly held = new Map<number, Uint8Array>();

  constructor(
    /** How many later chunks may pile up before we give up on the missing one. */
    private readonly gapTolerance = 3,
  ) {}

  /** Feed one chunk; returns the chunks now playable, in order. */
  push(seq: number, audio: Uint8Array): Uint8Array[] {
    if (seq < this.next) return []; // already played past it — too late to matter
    this.held.set(seq, audio);
    const ready: Uint8Array[] = [];
    for (;;) {
      const hit = this.held.get(this.next);
      if (hit) {
        this.held.delete(this.next);
        this.next++;
        ready.push(hit);
        continue;
      }
      // Nothing for the slot we want. Skip it only once enough has stacked up
      // behind it that the chunk is clearly lost rather than merely in flight.
      if (this.held.size > this.gapTolerance) {
        this.next++;
        continue;
      }
      break;
    }
    return ready;
  }

  /** End of transmission: release whatever is still held, in sequence order. */
  flush(): Uint8Array[] {
    const rest = [...this.held.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    this.held.clear();
    return rest;
  }
}
