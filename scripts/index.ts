/**
 * Build the search index from data/posts.jsonl.
 *
 *   npm run index                      embed everything new (needs an embedding key in .env or the environment:
 *                                      VOYAGE_API_KEY, or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID, or GEMINI_API_KEY)
 *   npm run index -- --provider voyage pick the provider when several keys are set (also ROR_EMBED_PROVIDER)
 *   npm run index -- --no-embed        keyword-only index, no API key needed
 *   npm run index -- --fresh           ignore the embedding cache and re-embed everything
 *   npm run index -- --limit 200       only the newest 200 posts (smoke test)
 *   npm run index -- --batch 50 --concurrency 2
 */
import path from 'node:path';
import { embedderFromEnv, PROVIDER_LABELS } from '../lib/embeddings.ts';
import { loadDotEnv } from '../lib/env.ts';
import { buildIndex } from '../lib/indexer.ts';
import { indexDir, postsFile } from '../lib/store.ts';

loadDotEnv();
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};

const embedder = flag('no-embed') ? null : embedderFromEnv(process.env, value('provider'));
if (!flag('no-embed') && !embedder) {
  console.error(
    value('provider')
      ? `No key found for the "${value('provider')}" embedding provider. See .env.example for the variables it needs.`
      : 'No embedding key found. Set VOYAGE_API_KEY (recommended), or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID, or GEMINI_API_KEY in .env (see .env.example), or pass --no-embed for a keyword-only index.',
  );
  process.exit(1);
}
if (embedder) console.log(`[index] Embedding with ${PROVIDER_LABELS[embedder.provider]} (${embedder.model}, ${embedder.dimensions} dims).`);

buildIndex({
  postsFile: postsFile(),
  outDir: indexDir(),
  embedder,
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
