/// <reference lib="webworker" />
// The background layout for vaults too big to slice on the UI thread: the same
// pipeline as `prelayout.ts`, answered once with the finished positions.

import type { Graph } from "./buildGraph";
import type { GraphSettings } from "./graphSettings";
import { computeLayout } from "./layoutCompute";

onmessage = async (e: MessageEvent<{ graph: Graph; settings: GraphSettings }>) => {
  const { graph, settings } = e.data;
  postMessage(await computeLayout(graph, settings, () => false, () => Promise.resolve()));
};
