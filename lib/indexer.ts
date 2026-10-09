/**
 * Builds data/index from data/posts.jsonl: enriched posts, chunks, and embeddings quantised to int8.
 * Embeddings are cached by content hash, so re-running after a new scrape only embeds what changed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { chunkPosts } from './chunker.ts';
import { EmbeddingError, PROVIDER_LABELS, type Embedder } from './embeddings.ts';
import { cleanPosts, FILTERS_VERSION } from './filters.ts';
import { enrichPost, readPostsJsonl, sortNewestFirst } from './posts.ts';
import type { Chunk, IndexMeta, IndexedPost } from './types.ts';
import { concatTables, decodeTable, emptyTable, encodeTable, quantize, selectRows, type VectorTable } from './vectors.ts';

interface BuildOptions {
  postsFile: string;
  outDir: string;
  /** null builds a keyword-only index (no vectors) so the app can run before a key exists. */
  embedder: Embedder | null;
  batchSize?: number;
  concurrency?: number;
  /** Only index the newest N posts (handy for smoke tests). */
  limit?: number;
  fresh?: boolean;
  log?: (message: string) => void;
}

interface BuildResult {
  meta: IndexMeta;
  embedded: number;
  reused: number;
}

interface Cache {
  model: string;
  dimensions: number;
  keys: string[];
  table: VectorTable;
}

export async function buildIndex(options: BuildOptions): Promise<BuildResult> {
  const log = options.log ?? (() => {});
  const embedder = options.embedder;
  const model = embedder?.model ?? 'none';
  const dimensions = embedder?.dimensions ?? 0;

  const raw = await readPostsJsonl(options.postsFile);
  if (raw.length === 0) throw new Error(`No posts found in ${options.postsFile}. Run the scraper first.`);
  const cleaned = cleanPosts(raw);
  let posts: IndexedPost[] = sortNewestFirst(cleaned.posts.map(enrichPost));
  if (options.limit) posts = posts.slice(0, options.limit);
  const chunks = chunkPosts(posts, { model, dimensions });
  const { ad, falcons, listing, noise, duplicate, unanswered } = cleaned.dropped;
  log(`Read ${raw.length} posts; kept ${posts.length} (dropped ${ad} ads, ${falcons} Falcon trades, ${listing} listings, ${noise} filler posts, ${duplicate} duplicates, ${unanswered} unanswered requests and ${cleaned.commentsDropped} noise comments) and made ${chunks.length} chunks.`);

  mkdirSync(options.outDir, { recursive: true });
  let table = emptyTable(dimensions);
  let embedded = 0;
  let reused = 0;

  if (embedder) {
    const cache = options.fresh ? { model, dimensions, keys: [], table: emptyTable(dimensions) } : loadCache(options.outDir, model, dimensions);
    const known = new Map(cache.keys.map((key, row) => [key, row]));
    const missing = chunks.filter((chunk) => !known.has(chunk.hash));
    reused = chunks.length - missing.length;
    log(`${reused} chunks already embedded, ${missing.length} to embed with ${PROVIDER_LABELS[embedder.provider]} ${model} (${dimensions} dims).`);
    if (missing.length > 0) {
      embedded = await embedMissing(embedder, missing, cache, options, log);
      saveCache(options.outDir, cache);
    }
    const rows = chunks.map((chunk) => {
      const row = known.get(chunk.hash) ?? cache.keys.indexOf(chunk.hash);
      if (row < 0) throw new Error(`Chunk ${chunk.id} was not embedded.`);
      return row;
    });
    table = selectRows(cache.table, rows);
  }

  const meta: IndexMeta = {
    version: 2,
    model,
    dimensions,
    builtAt: new Date().toISOString(),
    posts: posts.length,
    comments: posts.reduce((sum, post) => sum + post.comments.length, 0),
    chunks: chunks.length,
    quantization: 'int8',
    newestPost: posts.find((post) => post.date)?.date ?? '',
    oldestPost: [...posts].reverse().find((post) => post.date)?.date ?? '',
    filters: FILTERS_VERSION,
  };
  if (embedder) meta.provider = embedder.provider;
  writeFileSync(path.join(options.outDir, 'posts.json.gz'), gzipSync(JSON.stringify(posts)));
  writeFileSync(path.join(options.outDir, 'chunks.json.gz'), gzipSync(JSON.stringify(chunks satisfies Chunk[])));
  if (table.count > 0) writeFileSync(path.join(options.outDir, 'vectors.bin'), encodeTable(table));
  writeFileSync(path.join(options.outDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  log(`Wrote ${options.outDir} (${meta.posts} posts, ${meta.comments} comments, ${meta.chunks} chunks${table.count ? ', vectors' : ', keyword-only'}).`);
  return { meta, embedded, reused };
}

async function embedMissing(embedder: Embedder, missing: Chunk[], cache: Cache, options: BuildOptions, log: (message: string) => void): Promise<number> {
  const batchSize = Math.min(embedder.maxBatch, Math.max(1, options.batchSize ?? embedder.batchSize));
  const concurrency = Math.max(1, options.concurrency ?? embedder.concurrency);
  const batches: Chunk[][] = [];
  for (let i = 0; i < missing.length; i += batchSize) batches.push(missing.slice(i, i + batchSize));
  let next = 0;
  let done = 0;
  let sinceCheckpoint = 0;
  const started = Date.now();

  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++]!;
      const vectors = await embedWithPatience(embedder, batch, log);
      cache.keys.push(...batch.map((chunk) => chunk.hash));
      cache.table = concatTables(cache.table, quantize(vectors, embedder.dimensions));
      done += batch.length;
      sinceCheckpoint += batch.length;
      const elapsed = (Date.now() - started) / 1000;
      const rate = done / Math.max(1, elapsed);
      const eta = Math.round((missing.length - done) / Math.max(0.1, rate));
      log(`Embedded ${done}/${missing.length} (${rate.toFixed(1)}/s, ~${eta}s left)`);
      if (sinceCheckpoint >= 1000) {
        saveCache(options.outDir, cache);
        sinceCheckpoint = 0;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  return done;
}

/** Retries a batch through quota errors for a long time: overnight indexing should survive a rate-limit blip. */
async function embedWithPatience(embedder: Embedder, batch: Chunk[], log: (message: string) => void): Promise<Float32Array[]> {
  let attempt = 0;
  while (true) {
    try {
      return await embedder.embed(
        batch.map((chunk) => chunk.text),
        'document',
        { retries: 4 },
      );
    } catch (error) {
      attempt++;
      if (!(error instanceof EmbeddingError) || !error.retryable || attempt > 30) throw error;
      const wait = Math.min(120_000, error.retryAfterMs ?? 5_000 * attempt);
      log(`${PROVIDER_LABELS[embedder.provider]} said "${error.message.slice(0, 120)}"; waiting ${Math.round(wait / 1000)}s.`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

function loadCache(dir: string, model: string, dimensions: number): Cache {
  const metaFile = path.join(dir, 'cache-meta.json');
  const keysFile = path.join(dir, 'cache-keys.json.gz');
  const tableFile = path.join(dir, 'cache-vectors.bin');
  if (existsSync(metaFile) && existsSync(keysFile) && existsSync(tableFile)) {
    const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as { model: string; dimensions: number };
    if (meta.model === model && meta.dimensions === dimensions) {
      const keys = JSON.parse(gunzipSync(readFileSync(keysFile)).toString('utf8')) as string[];
      const table = decodeTable(readFileSync(tableFile));
      if (table.count === keys.length) return { model, dimensions, keys, table };
    }
  }
  // Fall back to reusing the published index when it matches; otherwise start empty.
  const indexMeta = path.join(dir, 'meta.json');
  const chunksFile = path.join(dir, 'chunks.json.gz');
  const vectorsFile = path.join(dir, 'vectors.bin');
  if (existsSync(indexMeta) && existsSync(chunksFile) && existsSync(vectorsFile)) {
    const meta = JSON.parse(readFileSync(indexMeta, 'utf8')) as IndexMeta;
    if (meta.model === model && meta.dimensions === dimensions) {
      const chunks = JSON.parse(gunzipSync(readFileSync(chunksFile)).toString('utf8')) as Chunk[];
      const table = decodeTable(readFileSync(vectorsFile));
      if (table.count === chunks.length) return { model, dimensions, keys: chunks.map((chunk) => chunk.hash), table };
    }
  }
  return { model, dimensions, keys: [], table: emptyTable(dimensions) };
}

function saveCache(dir: string, cache: Cache): void {
  writeFileSync(path.join(dir, 'cache-meta.json'), JSON.stringify({ model: cache.model, dimensions: cache.dimensions, count: cache.keys.length }));
  writeFileSync(path.join(dir, 'cache-keys.json.gz'), gzipSync(JSON.stringify(cache.keys)));
  writeFileSync(path.join(dir, 'cache-vectors.bin'), encodeTable(cache.table));
}
