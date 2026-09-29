/**
 * Build the search index from data/posts.jsonl.
 *
 *   npm run index                 embed everything new with Gemini (needs GEMINI_API_KEY in .env or the environment)
 *   npm run index -- --no-embed   keyword-only index, no API key needed
 *   npm run index -- --fresh      ignore the embedding cache and re-embed everything
 *   npm run index -- --limit 200  only the newest 200 posts (smoke test)
 *   npm run index -- --batch 50 --concurrency 2
 */
import path from 'node:path';
import { loadDotEnv } from '../lib/env.ts';
import { geminiConfig } from '../lib/gemini.ts';
import { buildIndex } from '../lib/indexer.ts';
import { indexDir, postsFile } from '../lib/store.ts';

loadDotEnv();
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};

const gemini = flag('no-embed') ? null : geminiConfig();
if (!flag('no-embed') && !gemini) {
  console.error('GEMINI_API_KEY is not set. Put it in .env (see .env.example) or pass --no-embed for a keyword-only index.');
  process.exit(1);
}

buildIndex({
  postsFile: postsFile(),
  outDir: indexDir(),
  gemini,
  batchSize: Number(value('batch')) || undefined,
  concurrency: Number(value('concurrency')) || undefined,
  limit: Number(value('limit')) || undefined,
  fresh: flag('fresh'),
  log: (message) => console.log(`[index] ${message}`),
})
  .then((result) => {
    console.log(`[index] Done: ${result.embedded} embedded, ${result.reused} reused. Index in ${path.relative(process.cwd(), indexDir())}/.`);
  })
  .catch((error) => {
    console.error('[index] Failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
