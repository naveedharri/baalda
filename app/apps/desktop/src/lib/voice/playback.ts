// Playback for incoming push-to-talk audio.
//
// Chunks are scheduled back-to-back on the AudioContext timeline rather than
// played one at a time on arrival. Playing on arrival would put a network-jitter
// gap between every 200 ms chunk, which is audible as chopping; keeping a
// running cursor and starting each buffer exactly where the last one ends makes
// the stream continuous as long as chunks keep up.
//
// Nothing is retained. A chunk is turned into an AudioBuffer, scheduled, and
// dropped; when a transmission ends its state is deleted. There is no history
// to replay and none is wanted — that is the feature.

import { ChunkOrderer, pcm16ToFloat } from "./pcm";

/** How far ahead of "now" a fresh stream starts playing — the receiver's half
 *  of the mouth-to-ear delay.
 *
 *  This was one 200 ms chunk of slack. Chunks are 40 ms now, but dropping the
 *  lead to match would leave nothing to absorb jitter, so it sits at 80 ms: two
 *  chunks of cushion, and 120 ms less delay than before. */
const LEAD_SECONDS = 0.08;

/**
 * Past this much scheduled-but-unplayed audio, a stream has fallen behind and
 * is re-anchored to the present. Latency in a walkie-talkie is worse than a
 * skip: without this, a listener whose network hiccuped keeps drifting further
 * behind for the rest of the transmission and never catches up.
 */
const MAX_DRIFT_SECONDS = 1.0;

interface Stream {
  orderer: ChunkOrderer;
  /** Who is transmitting. Streams are keyed by streamId, but the "talking"
   *  signal is per user, and one user can briefly own two streams. */
  userId: string;
  /** AudioContext time at which the next chunk should start. */
  cursor: number;
  sampleRate: number;
  live: Set<AudioBufferSourceNode>;
}

export interface VoicePlayerEvents {
  /** A teammate started or stopped transmitting — drives the "talking" UI. */
  onSpeakingChange?: (userId: string, speaking: boolean) => void;
}

export class VoicePlayer {
  private ctx: AudioContext | null = null;
  /** Shared output bus: every stream mixes into this, never straight into the
   *  destination. See {@link outputBus}. */
  private bus: AudioNode | null = null;
  private readonly streams = new Map<string, Stream>();

  constructor(private readonly events: VoicePlayerEvents = {}) {}

  /**
   * Lazily create the shared AudioContext.
   *
   * Returns null when audio is unavailable, and callers treat that as "no
   * sound" rather than an error — the same contract the mention chime uses, so
   * a machine with no output device degrades to the visual indicator instead of
   * throwing on every inbound chunk.
   */
  private audioContext(): AudioContext | null {
    try {
      this.ctx ??= new AudioContext();
      // Receivers get no user gesture at all, so a suspended context is the
      // expected state rather than an edge case. `resume()` is enough in the
      // desktop webviews (the mention chime has shipped on exactly this), and
      // if a platform ever refuses, playback silently no-ops.
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return this.ctx;
    } catch {
      return null;
    }
  }

  /**
   * Where every stream connects, instead of `ctx.destination` directly.
   *
   * Two people talking used to sum at unity gain straight into the output.
   * Capture runs with `autoGainControl`, so each speaker already arrives near
   * full scale, and the sum of two clipped hard — the overlap didn't just sound
   * loud, it sounded broken. A limiter costs nothing when one person is talking
   * (nothing exceeds the threshold) and is the difference between "two voices"
   * and "distortion" when two are.
   */
  private outputBus(ctx: AudioContext): AudioNode {
    if (!this.bus) {
      const limiter = ctx.createDynamicsCompressor();
      // Fast, transparent limiting rather than audible pumping: clamp only the
      // peaks that would clip, and let go quickly so speech isn't squashed.
      limiter.threshold.value = -6;
      limiter.knee.value = 3;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.12;
      limiter.connect(ctx.destination);
      this.bus = limiter;
    }
    return this.bus;
  }

  /** Is anyone else still transmitting as this user? Guards the "stopped
   *  talking" signal — see the note where it's used. */
  private stillSpeaking(userId: string, exceptStreamId: string): boolean {
    for (const [id, s] of this.streams) {
      if (id !== exceptStreamId && s.userId === userId) return true;
    }
    return false;
  }

  /**
   * Accept one inbound chunk.
   *
   * `streamId` groups a transmission, `seq` orders it, `final` closes it. Two
   * teammates talking at once are two streams and both play — mixing is what
   * the AudioContext does for free, and cutting one off would be a worse
   * surprise than overlap.
   */
  push(opts: {
    streamId: string;
    userId: string;
    seq: number;
    audio: Uint8Array;
    sampleRate?: number;
    final?: boolean;
  }): void {
    const ctx = this.audioContext();
    if (!ctx) return;

    let stream = this.streams.get(opts.streamId);
    if (!stream) {
      stream = {
        orderer: new ChunkOrderer(),
        userId: opts.userId,
        cursor: ctx.currentTime + LEAD_SECONDS,
        sampleRate: opts.sampleRate ?? 16_000,
        live: new Set(),
      };
      this.streams.set(opts.streamId, stream);
      this.events.onSpeakingChange?.(opts.userId, true);
    }

    for (const chunk of stream.orderer.push(opts.seq, opts.audio)) {
      this.schedule(ctx, stream, chunk);
    }

    if (opts.final) {
      for (const chunk of stream.orderer.flush()) this.schedule(ctx, stream, chunk);
      // Hold the entry until the audio actually finishes, so "talking" clears
      // when the listener stops hearing them, not when the last byte arrived.
      const endsIn = Math.max(0, stream.cursor - ctx.currentTime);
      const id = opts.streamId;
      const user = opts.userId;
      setTimeout(
        () => {
          this.streams.delete(id);
          // Only if this was their LAST stream. A second press landing before
          // the first transmission finished playing (or a reconnect minting a
          // new streamId mid-press) meant the older stream's timer cleared the
          // indicator for a user who is still talking.
          if (!this.stillSpeaking(user, id)) {
            this.events.onSpeakingChange?.(user, false);
          }
        },
        endsIn * 1000 + 50,
      );
    }
  }

  private schedule(ctx: AudioContext, stream: Stream, pcm: Uint8Array): void {
    const samples = pcm16ToFloat(pcm);
    if (samples.length === 0) return;
    const buffer = ctx.createBuffer(1, samples.length, stream.sampleRate);
    buffer.copyToChannel(samples, 0);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.outputBus(ctx));

    // Never schedule in the past — a cursor that has fallen behind `currentTime`
    // would make every remaining chunk play immediately and on top of the last.
    const now = ctx.currentTime;
    if (stream.cursor < now || stream.cursor - now > MAX_DRIFT_SECONDS) {
      stream.cursor = now + LEAD_SECONDS;
    }
    src.start(stream.cursor);
    stream.cursor += buffer.duration;

    stream.live.add(src);
    src.onended = () => stream.live.delete(src);
  }

  /** True while anything is playing — for the "someone is talking" indicator. */
  isPlaying(): boolean {
    return this.streams.size > 0;
  }

  /** Stop everything immediately and forget it (sign-out, vault switch, mute). */
  stopAll(): void {
    for (const stream of this.streams.values()) {
      for (const src of stream.live) {
        try {
          src.stop();
        } catch {
          /* already ended */
        }
      }
      stream.live.clear();
    }
    this.streams.clear();
  }
}
