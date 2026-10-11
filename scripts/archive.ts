/**
 * Moves the group archive between data/ and the project's private Vercel Blob store. The posts and the search index
 * built from them hold students' names and words, so they never go into git; the build pulls the index from the store
 * and the indexer workflow pulls the posts and pushes the index back. Needs BLOB_READ_WRITE_TOKEN (Vercel sets it on
 * builds; `vercel env pull` writes it to .env.local).
 *
 *   tsx scripts/archive.ts pull posts       data/posts.jsonl from the store, with data/removed.json
 *   tsx scripts/archive.ts pull index       data/index/ from the store (with the embedding cache)
 *   tsx scripts/archive.ts push posts       data/posts.jsonl to the store
 *   tsx scripts/archive.ts push index       data/index/ to the store
 *   tsx scripts/archive.ts push removed     data/removed.json (posts and authors to leave out) to the store
 *   tsx scripts/archive.ts pull index --if-missing   only when data/index/ has no index yet (local builds)
 *   tsx scripts/archive.ts push posts --force        even when the file has fewer posts than the store
 *
 * The index is written under its own folder (index/<builtAt>/) and index/current.json is pointed at it last, so a
 * build that pulls while the indexer is pushing still gets one whole index. Older folders are removed, except the
 * one before, which a build might still be reading.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { del, get, list, put } from '@vercel/blob';
import { loadDotEnv } from '../lib/env.ts';
import { indexDir, postsFile } from '../lib/store.ts';

const INDEX_FILES = ['meta.json', 'posts.json.gz', 'chunks.json.gz', 'vectors.bin'];
const CACHE_FILES = ['cache-meta.json', 'cache-keys.json.gz', 'cache-vectors.bin'];

loadDotEnv();
loadDotEnv('.env.local');
const [command, what] = process.argv.slice(2);
const ifMissing = process.argv.includes('--if-missing');
const token = process.env.BLOB_READ_WRITE_TOKEN;
const removedFile = () => path.join(path.dirname(postsFile()), 'removed.json');

async function download(pathname: string): Promise<Buffer | null> {
  const result = await get(pathname, { access: 'private', token, useCache: false });
  if (!result || result.statusCode !== 200) return null;
  return Buffer.from(await new Response(result.stream).arrayBuffer());
}

async function upload(pathname: string, body: Buffer): Promise<void> {
  await put(pathname, body, { access: 'private', token, addRandomSuffix: false, allowOverwrite: true, multipart: body.length > 8_000_000 });
}

async function pullPosts(): Promise<void> {
  const body = await download('posts.jsonl');
  if (!body) throw new Error('The store has no posts.jsonl.');
  writeFileSync(postsFile(), body);
  const removed = await download('removed.json');
  if (removed) writeFileSync(removedFile(), removed);
  console.log(`[archive] Pulled posts.jsonl (${(body.length / 1e6).toFixed(1)} MB)${removed ? ' and the removal list' : ''}.`);
}

async function pushRemoved(): Promise<void> {
  await upload('removed.json', readFileSync(removedFile()));
  console.log('[archive] Pushed the removal list.');
}

async function pushPosts(): Promise<void> {
  const body = readFileSync(postsFile());
  // The scraper only ever adds posts, so a smaller file means a partial or wrong one.
  const stored = await download('posts.jsonl');
  const lines = (buffer: Buffer) => buffer.toString('utf8').split('\n').filter(Boolean).length;
  if (stored && lines(body) < lines(stored) && !process.argv.includes('--force')) {
    throw new Error(`data/posts.jsonl has ${lines(body)} posts and the store has ${lines(stored)}; pass --force to replace it anyway.`);
  }
  await upload('posts.jsonl', body);
  console.log(`[archive] Pushed posts.jsonl (${(body.length / 1e6).toFixed(1)} MB).`);
}

async function pullIndex(): Promise<void> {
  const dir = indexDir();
  if (ifMissing && existsSync(path.join(dir, 'meta.json'))) {
    console.log('[archive] data/index/ is already here; not pulling.');
    return;
  }
  const pointer = await download('index/current.json');
  if (!pointer) throw new Error('The store has no index yet.');
  const { folder } = JSON.parse(pointer.toString('utf8')) as { folder: string };
  mkdirSync(dir, { recursive: true });
  for (const file of [...INDEX_FILES, ...CACHE_FILES]) {
    const body = await download(`${folder}/${file}`);
    if (!body && INDEX_FILES.includes(file)) throw new Error(`The store's index is missing ${file}.`);
    if (body) writeFileSync(path.join(dir, file), body);
  }
  console.log(`[archive] Pulled the index from ${folder}/.`);
}

async function pushIndex(): Promise<void> {
  const dir = indexDir();
  const meta = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8')) as { builtAt: string };
  const folder = `index/${meta.builtAt.replace(/[^0-9A-Za-z]/g, '')}`;
  for (const file of [...INDEX_FILES, ...CACHE_FILES]) {
    const local = path.join(dir, file);
    if (!existsSync(local)) {
      if (INDEX_FILES.includes(file)) throw new Error(`data/index/ is missing ${file}.`);
      continue;
    }
    await upload(`${folder}/${file}`, readFileSync(local));
  }
  const previous = await download('index/current.json');
  const keep = new Set([folder, previous ? (JSON.parse(previous.toString('utf8')) as { folder: string }).folder : folder]);
  await upload('index/current.json', Buffer.from(JSON.stringify({ folder })));
  const stale: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: 'index/', token, cursor });
    for (const blob of page.blobs) {
      const blobFolder = blob.pathname.split('/').slice(0, 2).join('/');
      if (blob.pathname !== 'index/current.json' && !keep.has(blobFolder)) stale.push(blob.url);
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  if (stale.length) await del(stale, { token });
  console.log(`[archive] Pushed the index to ${folder}/ and removed ${stale.length} old files.`);
}

const actions: Record<string, () => Promise<void>> = {
  'pull posts': pullPosts,
  'push posts': pushPosts,
  'push removed': pushRemoved,
  'pull index': pullIndex,
  'push index': pushIndex,
};
const action = actions[`${command} ${what}`];
if (!action) {
  console.error('Usage: tsx scripts/archive.ts pull|push posts|index, push removed [--if-missing] [--force]');
  process.exit(1);
}
if (!token) {
  // A hosted build without the store would deploy an empty archive, so it stops; a laptop without the token just
  // carries on with whatever data/ holds.
  if (process.env.VERCEL === '1' || process.env.CI) {
    console.error('[archive] BLOB_READ_WRITE_TOKEN is not set, so the archive cannot be reached.');
    process.exit(1);
  }
  console.log('[archive] No BLOB_READ_WRITE_TOKEN (run `vercel env pull`); using data/ as it is.');
  process.exit(0);
}
await action().catch((error) => {
  console.error('[archive] Failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
