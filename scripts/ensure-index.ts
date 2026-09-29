/**
 * Runs during `npm run build`. On Vercel/CI (or with --force), if data/index/ is missing it builds one from
 * data/posts.jsonl so the deploy works immediately. Keyword-only by default; set ROR_EMBED_ON_BUILD=1 (with GEMINI_API_KEY) to embed
 * during the build as well. A committed data/index/ (from `npm run index`) is always left untouched.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { embedderFromEnv } from '../lib/embeddings.ts';
import { loadDotEnv } from '../lib/env.ts';
import { buildIndex } from '../lib/indexer.ts';
import { indexDir, postsFile } from '../lib/store.ts';

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
