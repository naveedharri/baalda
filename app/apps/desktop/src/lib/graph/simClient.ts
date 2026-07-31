// Main-thread handle to the force-layout Web Worker (`simWorker.ts`). Owns the
// worker's lifecycle and turns its streamed position buffers into a callback.
// Used only for large global graphs; small/local graphs run the sim inline.

import type { GraphSettings } from "./graphSettings";

export interface SimNodeSpec {
  id: string;
  radius: number;
  weight: number;
}
export interface SimLinkSpec {
  source: number; // index into the node array
  target: number;
}

/** (positions, alpha, generation) — positions is a flat [x0,y0,x1,y1,…] buffer
 *  in the same order as the nodes passed to `init`. `generation` lets the caller
 *  drop buffers from a superseded layout. */
export type PositionsHandler = (
  buf: Float32Array,
  alpha: number,
  generation: number,
) => void;
export type SettledHandler = (generation: number) => void;

export class SimClient {
  private worker: Worker;
  private generation = 0;

  constructor(onPositions: PositionsHandler, onSettled: SettledHandler) {
    this.worker = new Worker(new URL("./simWorker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (e: MessageEvent) => {
      const m = e.data as
        | { type: "positions"; buf: Float32Array; alpha: number; generation: number }
        | { type: "settled"; generation: number };
      if (m.type === "positions") onPositions(m.buf, m.alpha, m.generation);
      else if (m.type === "settled") onSettled(m.generation);
    };
  }

  /** Start (or restart) the layout. Returns the generation id for this run so
   *  the caller can ignore late buffers from an earlier one. */
  init(
    nodes: SimNodeSpec[],
    links: SimLinkSpec[],
    settings: GraphSettings,
    width: number,
    height: number,
    intro: boolean,
  ): number {
    this.generation += 1;
    this.worker.postMessage({
      type: "init",
      generation: this.generation,
      nodes,
      links,
      settings,
      width,
      height,
      intro,
    });
    return this.generation;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  setSettings(settings: GraphSettings): void {
    this.worker.postMessage({ type: "settings", settings });
  }
  reheat(alpha: number): void {
    this.worker.postMessage({ type: "reheat", alpha });
  }
  fix(i: number, x: number, y: number): void {
    this.worker.postMessage({ type: "fix", i, x, y });
  }
  release(i: number): void {
    this.worker.postMessage({ type: "release", i });
  }
  stop(): void {
    this.worker.postMessage({ type: "stop" });
  }
  dispose(): void {
    this.worker.terminate();
  }
}
