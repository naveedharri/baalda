// AudioWorklet processor for push-to-talk capture.
//
// Plain JS on purpose: this runs in AudioWorkletGlobalScope, not the page, so
// it is loaded as its own asset rather than bundled with the app code. It is
// referenced via `new URL("./recorder-worklet.js", import.meta.url)` so Vite
// emits it as a same-origin asset — the Tauri CSP is `script-src 'self'`, which
// rules out the usual blob:-URL trick for inlining a worklet.
//
// Its whole job is to batch. The audio thread hands us 128-sample render
// quanta; forwarding each one would mean ~375 postMessages a second. We
// accumulate at the hardware rate and post roughly a chunk's worth at a time,
// leaving resampling and Int16 conversion to the main thread where they're
// testable.

// Must match VOICE_CHUNK_MS in pcm.ts. This is the single biggest contributor
// to mouth-to-ear delay: no audio can exist before one full batch is filled, so
// the value is a hard floor on how fast the first word leaves the machine.
const BATCH_MS = 40;

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` is a global in AudioWorkletGlobalScope — the hardware rate,
    // typically 48000, which is why the main thread has to resample at all.
    this._batchSize = Math.round((sampleRate * BATCH_MS) / 1000);
    this._buffer = new Float32Array(this._batchSize);
    this._filled = 0;
    this._stopped = false;
    this.port.onmessage = (e) => {
      if (e.data === "stop") {
        // Flush the tail so the last fraction of a second isn't clipped off the
        // end of every transmission.
        this._stopped = true;
        if (this._filled > 0) {
          this.port.postMessage(this._buffer.slice(0, this._filled));
          this._filled = 0;
        }
        this.port.postMessage("stopped");
      }
    };
  }

  process(inputs) {
    if (this._stopped) return false; // let the node be collected
    const channel = inputs[0] && inputs[0][0];
    // No input yet (or the track ended): keep the processor alive regardless,
    // returning false here would permanently kill capture on a transient gap.
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this._buffer[this._filled++] = channel[i];
      if (this._filled === this._batchSize) {
        // `slice` copies — the buffer is reused immediately for the next batch.
        this.port.postMessage(this._buffer.slice(0));
        this._filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("baalda-recorder", RecorderProcessor);
