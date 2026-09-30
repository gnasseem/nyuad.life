/** Lexical (BM25) and dense retrieval over chunks, fused with reciprocal-rank fusion and a light recency prior. */
import { tokenize, dayNumber } from './text.ts';
import { topK, type VectorTable } from './vectors.ts';

export interface Bm25Index {
  n: number;
  avgLength: number;
  lengths: Float32Array;
  /** term -> flat [doc, tf, doc, tf, ...] */
  postings: Map<string, Uint32Array>;
}

const K1 = 1.4;
const B = 0.7;

export function buildBm25(docs: string[]): Bm25Index {
  const postings = new Map<string, number[]>();
  const lengths = new Float32Array(docs.length);
  let total = 0;
  docs.forEach((doc, row) => {
    const counts = new Map<string, number>();
    const tokens = tokenize(doc);
    lengths[row] = tokens.length;
    total += tokens.length;
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    for (const [term, tf] of counts) {
      let list = postings.get(term);
      if (!list) postings.set(term, (list = []));
      list.push(row, tf);
    }
  });
  const packed = new Map<string, Uint32Array>();
  for (const [term, list] of postings) packed.set(term, Uint32Array.from(list));
  return { n: docs.length, avgLength: docs.length ? total / docs.length : 1, lengths, postings: packed };
}

export function bm25Query(index: Bm25Index, terms: string[], k: number): Array<{ row: number; score: number }> {
  if (index.n === 0 || terms.length === 0) return [];
  const scores = new Map<number, number>();
  const unique = [...new Set(terms)];
  for (const term of unique) {
    const list = index.postings.get(term);
    if (!list) continue;
    const df = list.length / 2;
    const idf = Math.log(1 + (index.n - df + 0.5) / (df + 0.5));
    for (let i = 0; i < list.length; i += 2) {
      const row = list[i]!;
      const tf = list[i + 1]!;
      const norm = tf / (tf + K1 * (1 - B + (B * index.lengths[row]!) / index.avgLength));
      scores.set(row, (scores.get(row) ?? 0) + idf * norm * (K1 + 1));
    }
  }
  return [...scores.entries()]
    .map(([row, score]) => ({ row, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

export interface Hit {
  /** Position in archive.posts. */
  post: number;
  /** Best matching chunk row. */
  chunk: number;
  score: number;
  lexicalRank?: number;
  denseRank?: number;
}

interface FuseOptions {
  /** Post dates (ISO) by post position, for the recency prior. */
  dates: string[];
  chunkPost: Int32Array;
  today?: number;
  recencyWeight?: number;
}

/**
 * Reciprocal-rank fusion of lexical and dense chunk rankings, grouped to posts.
 * Each post keeps its best chunk; a small bonus favours posts from the last couple of years.
 */
export function fuse(
  lexical: Array<{ row: number; score: number }>,
  dense: Array<{ row: number; score: number }>,
  options: FuseOptions,
): Hit[] {
  const rrf = 60;
  const perChunk = new Map<number, { score: number; lexicalRank?: number; denseRank?: number }>();
  lexical.forEach(({ row }, rank) => {
    const entry = perChunk.get(row) ?? { score: 0 };
    entry.score += 1 / (rrf + rank + 1);
    entry.lexicalRank = rank + 1;
    perChunk.set(row, entry);
  });
  dense.forEach(({ row }, rank) => {
    const entry = perChunk.get(row) ?? { score: 0 };
    entry.score += 1 / (rrf + rank + 1);
    entry.denseRank = rank + 1;
    perChunk.set(row, entry);
  });
  const today = options.today ?? Date.now() / 86_400_000;
  const weight = options.recencyWeight ?? 0.004;
  const perPost = new Map<number, Hit>();
  for (const [chunk, entry] of perChunk) {
    const post = options.chunkPost[chunk]!;
    const age = today - dayNumber(options.dates[post] ?? '');
    const recency = Number.isNaN(age) ? 0.3 : Math.exp(-Math.max(0, age) / 540);
    const score = entry.score + weight * recency;
    const current = perPost.get(post);
    if (!current || score > current.score) {
      perPost.set(post, { post, chunk, score, lexicalRank: entry.lexicalRank, denseRank: entry.denseRank });
    }
  }
  return [...perPost.values()].sort((a, b) => b.score - a.score);
}

export function denseQuery(table: VectorTable, query: Float32Array, k: number): Array<{ row: number; score: number }> {
  return topK(table, query, k);
}
