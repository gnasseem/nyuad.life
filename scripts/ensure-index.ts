/**
 * Runs during `npm run build`, after scripts/archive.ts has pulled data/index/ from the private store. On Vercel/CI
 * (or with --force), if data/index/ is still missing it builds one from data/posts.jsonl. Keyword-only by default; set
 * ROR_EMBED_ON_BUILD=1 (with GEMINI_API_KEY) to embed during the build as well. An existing data/index/ is always left
 * untouched.
 */
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { embedderFromEnv } from '../lib/embeddings.ts';
import { loadDotEnv } from '../lib/env.ts';
import { buildIndex } from '../lib/indexer.ts';
import { indexDir, postsFile } from '../lib/store.ts';
import { buildOfficialIndex, officialFile, officialIndexDir, readOfficialJsonl } from '../lib/official.ts';

loadDotEnv();
const dir = indexDir();
const onHostedBuild = process.env.VERCEL === '1' || Boolean(process.env.CI) || process.argv.includes('--force');
if (existsSync(path.join(dir, 'meta.json'))) {
  console.log(`[ensure-index] Using the existing index in ${path.relative(process.cwd(), dir)}/.`);
} else if (!onHostedBuild) {
  console.log('[ensure-index] No data/index yet; the local API will read data/posts.jsonl directly. Run `npm run index` to build one.');
} else if (!existsSync(postsFile())) {
  console.warn('[ensure-index] No data/posts.jsonl found; the API will start empty. Run the scraper first.');
} else {
  const embed = process.env.ROR_EMBED_ON_BUILD === '1' ? embedderFromEnv() : null;
  if (process.env.ROR_EMBED_ON_BUILD === '1' && !embed) console.warn('[ensure-index] ROR_EMBED_ON_BUILD=1 but no embedding key is set; building a keyword-only index.');
  await buildIndex({ postsFile: postsFile(), outDir: dir, embedder: embed, log: (message) => console.log(`[ensure-index] ${message}`) });
}

// Official snapshots are committed separately from their index. Never deploy a newer snapshot with stale search results.
if (process.env.VERCEL === '1' && existsSync(officialFile())) {
  const docs = readOfficialJsonl(officialFile());
  const saved = path.join(officialIndexDir(), 'docs.json.gz');
  const matches = existsSync(saved) && gunzipSync(readFileSync(saved)).toString('utf8') === JSON.stringify(docs);
  if (!matches) {
    const embedder = embedderFromEnv();
    if (!embedder) throw new Error('Refreshing official sources needs an embedding key on Vercel.');
    await buildOfficialIndex({ file: officialFile(), outDir: officialIndexDir(), embedder, log: (message) => console.log(`[official-index] ${message}`) });
  }
}
