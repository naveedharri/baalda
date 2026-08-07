// Microphone capture for push-to-talk. Opens the mic on press, streams 16 kHz
// mono PCM16 chunks while held, closes it on release.
//
// The mic track is stopped every time the button comes up, not merely muted.
// That is a privacy property, not a tidiness one: while a MediaStreamTrack is
// live the OS shows the recording indicator, and a walkie-talkie that leaves it
// on between transmissions looks exactly like one that is always listening.

import {
  downsampleTo16k,
  floatToPcm16,
  VOICE_SAMPLE_RATE,
} from "./pcm";

/** Emitted for each captured chunk, already in wire format. */
export type ChunkSink = (audio: Uint8Array, seq: number) => void;

export interface CaptureHandle {
  /** Stop capturing, flush the tail, and release the mic. Idempotent. */
  stop(): Promise<void>;
}

export class MicPermissionError extends Error {
  constructor(
    message: string,
    /** True when the user (or the OS) refused, as opposed to no device etc. */
    readonly denied: boolean,
  ) {
    super(message);
    this.name = "MicPermissionError";
  }
}

/**
 * Start capturing. Each chunk is handed to `onChunk` with its sequence number.
 *
 * Rejects with {@link MicPermissionError} when the mic isn't available.
 *
 * PLATFORM STATE (verified 2026-08-06, wry 0.55.1 / tauri 2.11.5):
 *
 *  - **macOS** — needs `NSMicrophoneUsageDescription` (`src-tauri/Info.plist`)
 *    and `com.apple.security.device.audio-input` (`entitlements.plist`); both
 *    are now present. Older macOS 14.0–14.1 double-prompted (once at app level,
 *    once at webview level); Apple fixed that around 14.2.
 *  - **Windows / WebView2** — expected to prompt normally.
 *  - **Linux / WebKitGTK** — the known weak spot. WebKitGTK only grants media
 *    capture if the embedder answers `WebKitUserMediaPermissionRequest`, and
 *    wry's expanded permission API (`PermissionKind`, `PermissionResponse::Prompt`
 *    across WebView2/WKWebView/WebKitGTK) landed in **wry 0.56.0**, which is
 *    NEWER than the 0.55.1 this app pins. Users have reported Tauri v2 apps on
 *    WebKitGTK getting no prompt and no access at all. So expect this to reject
 *    on Linux until wry is bumped — which is exactly why the failure is surfaced
 *    as a message in the UI rather than swallowed.
 *
 * Untested on real Windows/Linux hardware; treat the two non-macOS rows as
 * expectations, not verified behaviour.
 */
export async function startCapture(onChunk: ChunkSink): Promise<CaptureHandle> {
  // The context and the worklet module are hoisted out of the press: building an
  // AudioContext and fetching/compiling/registering the worklet took a chunk of
  // the delay before the first word went out, and neither depends on the mic.
  // Only `getUserMedia` genuinely has to wait for the press — that one IS the
  // privacy property described at the top of this file.
  const ctx = await sharedCaptureContext();

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        // Let the platform do the work a walkie-talkie wants anyway; all three
        // engines implement these, and they cost us nothing.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    throw new MicPermissionError(
      name === "NotAllowedError"
        ? "Microphone access was refused."
        : "No microphone is available.",
      name === "NotAllowedError",
    );
  }

  // Only the mic is released on stop; the context outlives the transmission.
  const release = () => {
    for (const track of stream.getTracks()) track.stop();
  };

  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "baalda-recorder");
  let seq = 0;
  let stopped = false;
  let resolveStopped: (() => void) | null = null;

  node.port.onmessage = (e: MessageEvent) => {
    if (e.data === "stopped") {
      resolveStopped?.();
      return;
    }
    if (stopped) return;
    const batch = e.data as Float32Array;
    const audio = floatToPcm16(downsampleTo16k(batch, ctx.sampleRate));
    if (audio.length > 0) onChunk(audio, seq++);
  };

  source.connect(node);
  // A worklet with no downstream connection isn't guaranteed to be pulled, but
  // routing the mic to the speakers would be feedback. A zero-gain sink keeps
  // the graph running and silent.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(ctx.destination);

  return {
    async stop() {
      if (stopped) return;
      // Let the worklet's flush land BEFORE we mark ourselves stopped, or the
      // tail of every transmission is dropped by the guard above.
      const flushed = new Promise<void>((r) => {
        resolveStopped = r;
      });
      node.port.postMessage("stop");
      await Promise.race([flushed, new Promise((r) => setTimeout(r, 250))]);
      stopped = true;
      source.disconnect();
      node.disconnect();
      mute.disconnect();
      release();
    },
  };
}

/** The transmit format, for the opening chunk's header. */
export const CAPTURE_FORMAT = { fmt: "pcm16", sr: VOICE_SAMPLE_RATE } as const;

// ---- Shared capture context -------------------------------------------------

let capturePrep: Promise<AudioContext> | null = null;

/**
 * One AudioContext with the recorder worklet already registered, reused for the
 * life of the app. Built on first use and never closed.
 *
 * Kept apart from the playback context on purpose: this one is fed by the mic
 * with echo cancellation on, which on macOS switches the device to the
 * voice-processing IO unit. Sharing it with playback would put every teammate's
 * audio through that path too.
 */
async function sharedCaptureContext(): Promise<AudioContext> {
  if (!capturePrep) {
    capturePrep = (async () => {
      const ctx = new AudioContext();
      await ctx.audioWorklet.addModule(
        new URL("./recorder-worklet.js", import.meta.url),
      );
      return ctx;
    })();
    // A failed prep must not be cached, or every later press reuses the
    // rejection and the mic can never recover.
    capturePrep.catch(() => {
      capturePrep = null;
    });
  }
  const ctx = await capturePrep;
  // Autoplay policy can suspend an idle context between transmissions.
  if (ctx.state === "suspended") await ctx.resume();
  return ctx;
}

/**
 * Warm the capture path up before the button is pressed, so the first press
 * pays only for `getUserMedia`. Safe to call repeatedly; failures are ignored
 * here and surface properly on the real press.
 */
export function prewarmCapture(): void {
  void sharedCaptureContext().catch(() => {});
}
