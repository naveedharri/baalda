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

import {
  getGraphEdges,
  getGraphEdgesFor,
  getNoteMeta,
  listNoteTitles,
  type NoteTitle,
} from "../ipc";

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

/** What changed for a handful of notes: their current title rows and EVERY
 *  edge touching them (as source or target), fresh from the index. */
export interface GraphDelta {
  nodes: NoteTitle[];
  edges: GraphEdge[];
}

/**
 * Patch `graph` with a delta for the notes in `delta.nodes` (#83): their
 * titles/paths are refreshed, every edge touching them is replaced by the
 * delta's edges, and link counts are recomputed. Pure.
 *
 * Returns null when the delta names a note the graph does not have — a NEW note
 * (or one the graph predates). A new note can also resolve OTHER notes' dangling
 * `[[links]]`, which no per-note query would report, so the caller falls back to
 * a full rebuild there rather than guess.
 */
export function applyGraphDelta(graph: Graph, delta: GraphDelta): Graph | null {
  const changed = new Set(delta.nodes.map((n) => n.id));
  const known = new Set(graph.nodes.map((n) => n.id));
  for (const id of changed) if (!known.has(id)) return null;

  // Refresh the changed rows in place; everything else is carried over as-is.
  const fresh = new Map(delta.nodes.map((n) => [n.id, n] as const));
  const titles: NoteTitle[] = graph.nodes.map((n) => {
    const f = fresh.get(n.id);
    return f ?? { id: n.id, path: n.path, title: n.title };
  });

  // Every edge touching a changed note is stale (a removed [[link]] would
  // otherwise survive); the delta carries the current set for those notes.
  const kept: GraphEdge[] = graph.edges.filter(
    (e) => !changed.has(e.source) && !changed.has(e.target),
  );
  return assembleGraph(titles, [...kept, ...delta.edges]);
}

/**
 * Fetch a delta for `paths` (modified notes) — two round trips bounded by the
 * number of changed notes, not the vault. Returns null when any path no longer
 * resolves to an indexed note (deleted/renamed under us): full rebuild.
 */
export async function fetchGraphDelta(paths: string[]): Promise<GraphDelta | null> {
  const metas = await Promise.all(paths.map((p) => getNoteMeta(p)));
  const nodes: NoteTitle[] = [];
  for (const m of metas) {
    if (!m) return null;
    nodes.push({ id: m.id, path: m.path, title: m.title });
  }
  const edges = await getGraphEdgesFor(nodes.map((n) => n.id));
  return { nodes, edges };
}
