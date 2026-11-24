/**
 * Pluggable text embedder for semantic search (see indexer.ts / search route).
 *
 * The DEFAULT embedder is fully local and offline: a 256-dim hashed
 * bag-of-words. Tokens are lowercased word runs, each hashed into a bucket via
 * fnv1a; buckets accumulate term counts and the vector is L2-normalized so
 * cosine similarity == dot product. Deterministic (same text → same vector) and
 * dependency-free, so tests and air-gapped deploys work without any API.
 *
 * If OPENAI_API_KEY is set the caller MAY swap in a real embedder, but the local
 * one stays the default and everything must work with it alone.
 */

export const EMBED_DIM = 256;

export interface Embedder {
  readonly dim: number;
  embed(text: string): number[];
}

/** Split into lowercase word tokens (Unicode letter/number/underscore runs). */
export function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu);
  return matches ?? [];
}

/** 32-bit FNV-1a hash of a string (unsigned). */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // h *= 16777619, kept in 32-bit unsigned range without BigInt.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** L2-normalize in place; leaves an all-zero vector unchanged. */
export function l2normalize(vec: number[]): number[] {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vec;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

/** Local hashed bag-of-words embedder — the default. */
export const localEmbedder: Embedder = {
  dim: EMBED_DIM,
  embed(text: string): number[] {
    const vec = new Array<number>(EMBED_DIM).fill(0);
    for (const token of tokenize(text)) {
      vec[fnv1a(token) % EMBED_DIM] += 1;
    }
    return l2normalize(vec);
  },
};

/** Active embedder. Local by default; overridable for a real provider. */
export let embedder: Embedder = localEmbedder;

export function setEmbedder(next: Embedder): void {
  embedder = next;
}

/** Convenience wrapper used by the indexer and search route. */
export function embed(text: string): number[] {
  return embedder.embed(text);
}

/** Cosine similarity of two equal-length vectors (0 if either is degenerate). */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
