/** Lexical (BM25) and dense retrieval over chunks, fused with reciprocal-rank fusion and a light recency prior. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

/** A hash of the passages an index was built from: a saved index is only read back for exactly the same passages. */
export function corpusHash(docs: string[]): string {
  const hash = createHash('sha1');
  for (const doc of docs) hash.update(doc).update('\u0000');
  return hash.digest('hex');
}

/**
 * Tokenizing every passage is most of a cold start, so the build saves the index beside the corpus (scripts/ensure-index.ts)
 * and instances read it back. Layout: header length (uint32), the header as JSON (hash, sizes, terms), padding to four
 * bytes, the passage lengths (float32), then every term's postings one after another (uint32).
 */
export function writeBm25(file: string, index: Bm25Index, hash: string): void {
  const terms = [...index.postings.keys()];
  const sizes = terms.map((term) => index.postings.get(term)!.length);
  const header = Buffer.from(JSON.stringify({ hash, n: index.n, avgLength: index.avgLength, terms, sizes }));
  const start = Math.ceil((4 + header.length) / 4) * 4;
  const total = sizes.reduce((sum, size) => sum + size, 0);
  const out = Buffer.alloc(start + 4 * index.n + 4 * total);
  out.writeUInt32LE(header.length, 0);
  header.copy(out, 4);
  Buffer.from(index.lengths.buffer, index.lengths.byteOffset, 4 * index.n).copy(out, start);
  let at = start + 4 * index.n;
  for (const term of terms) {
    const list = index.postings.get(term)!;
    Buffer.from(list.buffer, list.byteOffset, 4 * list.length).copy(out, at);
    at += 4 * list.length;
  }
  writeFileSync(file, out);
}

/** The saved index for exactly these passages (by corpusHash), or null. */
export function readBm25(file: string, hash: string): Bm25Index | null {
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file);
    const headerLength = raw.readUInt32LE(0);
    const header = JSON.parse(raw.subarray(4, 4 + headerLength).toString('utf8')) as { hash: string; n: number; avgLength: number; terms: string[]; sizes: number[] };
    if (header.hash !== hash) return null;
    // Typed views need four-byte alignment; a Buffer may start anywhere in its memory.
    const bytes = raw.byteOffset % 4 === 0 ? raw : Buffer.from(raw);
    const start = Math.ceil((4 + headerLength) / 4) * 4;
    const lengths = new Float32Array(bytes.buffer, bytes.byteOffset + start, header.n);
    const postings = new Map<string, Uint32Array>();
    let at = bytes.byteOffset + start + 4 * header.n;
    header.terms.forEach((term, i) => {
      postings.set(term, new Uint32Array(bytes.buffer, at, header.sizes[i]!));
      at += 4 * header.sizes[i]!;
    });
    return { n: header.n, avgLength: header.avgLength, lengths, postings };
  } catch (error) {
    console.warn(`[search] could not read ${file}:`, (error as Error).message);
    return null;
  }
}

export function bm25Query(index: Bm25Index, terms: string[], k: number): Array<{ row: number; score: number }> {
  if (index.n === 0 || terms.length === 0) return [];
  const scores = new Map<number, number>();
  const unique = [...new Set(terms)];
  const matched = new Map<number, number>();
  let available = 0;
  for (const term of unique) {
    const list = index.postings.get(term);
    if (!list) continue;
    available++;
    const df = list.length / 2;
    const idf = Math.log(1 + (index.n - df + 0.5) / (df + 0.5));
    for (let i = 0; i < list.length; i += 2) {
      const row = list[i]!;
      matched.set(row, (matched.get(row) ?? 0) + 1);
      const tf = list[i + 1]!;
      const norm = tf / (tf + K1 * (1 - B + (B * index.lengths[row]!) / index.avgLength));
      scores.set(row, (scores.get(row) ?? 0) + idf * norm * (K1 + 1));
    }
  }
  return [...scores.entries()]
    .map(([row, score]) => ({ row, score: score * (0.25 + 0.75 * ((matched.get(row) ?? 0) / available) ** 2) }))
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
  /** Found because it names the course or the person asked about (lib/entities.ts), not by matching the question. */
  linked?: boolean;
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
