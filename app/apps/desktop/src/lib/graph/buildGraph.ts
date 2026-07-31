// Assembles the wikilink graph for the Graph View.
//
// Data source: `listNoteTitles` gives every note id/title/path; `getGraphEdges`
// gives every resolved edge (source id -> target id, "A -> B means A links to
// B") in a single query. Both are one IPC round-trip each, so building the
// graph is O(1) calls regardless of vault size — the old path fanned out one
// `getBacklinks` call per note, which stalled on large vaults.
//
// The IPC calls and the pure transformation are kept separate so the
// transformation (dedupe, self-link/dangling-link filtering, linkCount
// aggregation) can be unit-tested without Tauri.

import { getGraphEdges, listNoteTitles, type NoteTitle } from "../ipc";

export interface GraphNode {
  id: string;
  title: string;
  path: string;
  /** Number of distinct notes this note links to or is linked from. */
  linkCount: number;
}

export interface GraphEdge {
  /** Note id that contains the [[wikilink]]. */
  source: string;
  /** Note id the wikilink resolves to. */
  target: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * Pure transformation: notes + resolved edges -> a deduped node/edge graph.
 * Exported separately from `buildGraph` so tests can exercise it with fixture
 * data instead of a real Tauri backend. Drops self-loops and any edge whose
 * endpoints aren't both known notes, dedupes repeated links between a pair, and
 * aggregates each node's `linkCount` (distinct edges touching it).
 */
export function assembleGraph(titles: NoteTitle[], rawEdges: GraphEdge[]): Graph {
  const knownIds = new Set(titles.map((t) => t.id));
  const linkCount = new Map<string, number>();
  const edgeKeys = new Set<string>();
  const edges: GraphEdge[] = [];

  for (const e of rawEdges) {
    if (e.source === e.target) continue; // no self-loops
    if (!knownIds.has(e.source) || !knownIds.has(e.target)) continue; // drop dangling refs
    const key = `${e.source}->${e.target}`;
    if (edgeKeys.has(key)) continue; // dedupe repeated [[wikilinks]] between the same pair
    edgeKeys.add(key);
    edges.push({ source: e.source, target: e.target });
    linkCount.set(e.source, (linkCount.get(e.source) ?? 0) + 1);
    linkCount.set(e.target, (linkCount.get(e.target) ?? 0) + 1);
  }

  const nodes: GraphNode[] = titles.map((t) => ({
    id: t.id,
    title: t.title || t.path.split("/").pop() || t.path,
    path: t.path,
    linkCount: linkCount.get(t.id) ?? 0,
  }));

  return { nodes, edges };
}

/** Fetch note titles + all resolved edges from Tauri and assemble the graph. */
export async function buildGraph(): Promise<Graph> {
  const [titles, edges] = await Promise.all([listNoteTitles(), getGraphEdges()]);
  return assembleGraph(titles, edges);
}
