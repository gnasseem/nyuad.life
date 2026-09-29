/**
 * Loads the archive once per process: posts, chunks, int8 vectors and a BM25 index.
 * Falls back to chunking data/posts.jsonl on the fly when no built index exists, so the API works
 * (keyword search + Gemini answers) even before the embedding step has run.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { chunkPosts } from './chunker.ts';
import { enrichPost, isUsefulPost, readPostsJsonl, sortNewestFirst } from './posts.ts';
import { buildBm25, type Bm25Index } from './search.ts';
import type { Chunk, IndexMeta, IndexedPost, SourcePost } from './types.ts';
import { decodeTable, emptyTable, type VectorTable } from './vectors.ts';

export interface Archive {
  meta: IndexMeta;
  posts: IndexedPost[];
  postPosition: Map<string, number>;
  chunks: Chunk[];
  chunkPost: Int32Array;
  /** First chunk row of each post (for related-post lookups). */
  postChunk: Int32Array;
  vectors: VectorTable;
  bm25: Bm25Index;
  byCourse: Map<string, number[]>;
  byTopic: Map<string, number[]>;
  source: 'index' | 'posts.jsonl';
  loadedAt: string;
  loadMs: number;
}

export function dataRoot(): string {
  return process.env.ROR_DATA_ROOT ?? process.cwd();
}

export function indexDir(): string {
  return process.env.ROR_INDEX_DIR ?? path.join(dataRoot(), 'data', 'index');
}

export function postsFile(): string {
  return process.env.ROR_POSTS_FILE ?? path.join(dataRoot(), 'data', 'posts.jsonl');
}

let cached: Promise<Archive> | undefined;

export function loadArchive(): Promise<Archive> {
  if (!cached) {
    cached = load().catch((error) => {
      cached = undefined;
      throw error;
    });
  }
  return cached;
}

/** Test hook. */
export function resetArchive(): void {
  cached = undefined;
}

async function load(): Promise<Archive> {
  const started = Date.now();
  const dir = indexDir();
  const metaFile = path.join(dir, 'meta.json');
  if (existsSync(metaFile) && existsSync(path.join(dir, 'posts.json.gz')) && existsSync(path.join(dir, 'chunks.json.gz'))) {
    const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as IndexMeta;
    const posts = JSON.parse(gunzipSync(readFileSync(path.join(dir, 'posts.json.gz'))).toString('utf8')) as IndexedPost[];
    const chunks = JSON.parse(gunzipSync(readFileSync(path.join(dir, 'chunks.json.gz'))).toString('utf8')) as Chunk[];
    const vectorFile = path.join(dir, 'vectors.bin');
    let vectors = emptyTable(meta.dimensions);
    if (existsSync(vectorFile)) {
      vectors = decodeTable(readFileSync(vectorFile));
      if (vectors.count !== chunks.length) {
        console.warn(`[archive] vectors.bin has ${vectors.count} rows but there are ${chunks.length} chunks; using keyword search only.`);
        vectors = emptyTable(meta.dimensions);
      }
    }
    return assemble(meta, posts, chunks, vectors, 'index', started);
  }

  const raw = await readPostsJsonl(postsFile());
  const posts = sortNewestFirst(raw.filter(isUsefulPost).map(enrichPost));
  const chunks = chunkPosts(posts, { model: 'none', dimensions: 0 });
  const meta: IndexMeta = {
    version: 2,
    model: 'none',
    dimensions: 0,
    builtAt: new Date().toISOString(),
    posts: posts.length,
    comments: posts.reduce((sum, post) => sum + post.comments.length, 0),
    chunks: chunks.length,
    quantization: 'int8',
    newestPost: posts[0]?.date ?? '',
    oldestPost: [...posts].reverse().find((post) => post.date)?.date ?? '',
  };
  return assemble(meta, posts, chunks, emptyTable(0), 'posts.jsonl', started);
}

function assemble(
  meta: IndexMeta,
  posts: IndexedPost[],
  chunks: Chunk[],
  vectors: VectorTable,
  source: Archive['source'],
  started: number,
): Archive {
  const postPosition = new Map(posts.map((post, index) => [post.id, index]));
  const chunkPost = new Int32Array(chunks.length);
  const postChunk = new Int32Array(posts.length).fill(-1);
  chunks.forEach((chunk, row) => {
    const position = postPosition.get(chunk.postId);
    if (position === undefined) throw new Error(`Chunk ${chunk.id} refers to a post that is not in the archive.`);
    chunkPost[row] = position;
    if (postChunk[position] === -1) postChunk[position] = row;
  });
  const byCourse = new Map<string, number[]>();
  const byTopic = new Map<string, number[]>();
  posts.forEach((post, index) => {
    for (const course of post.courses) push(byCourse, course, index);
    for (const topic of post.topics) push(byTopic, topic, index);
  });
  return {
    meta,
    posts,
    postPosition,
    chunks,
    chunkPost,
    postChunk,
    vectors,
    bm25: buildBm25(chunks.map((chunk) => chunk.text)),
    byCourse,
    byTopic,
    source,
    loadedAt: new Date().toISOString(),
    loadMs: Date.now() - started,
  };
}

function push(map: Map<string, number[]>, key: string, value: number): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function postById(archive: Archive, id: string): IndexedPost | undefined {
  const position = archive.postPosition.get(id);
  return position === undefined ? undefined : archive.posts[position];
}

/** Public shape of a post for list views: everything except the full comment bodies. */
export function summarizePost(post: SourcePost & Partial<IndexedPost>, snippet?: string) {
  return {
    id: post.id,
    url: post.url,
    author: post.author,
    date: post.date,
    text: post.text,
    preview: post.text.length > 280 ? post.text.slice(0, 280).trimEnd() + '…' : post.text,
    snippet: snippet ?? '',
    commentCount: Math.max(post.commentCount ?? 0, post.comments.length),
    reactions: post.reactions ?? 0,
    topics: post.topics ?? [],
    courses: post.courses ?? [],
  };
}
