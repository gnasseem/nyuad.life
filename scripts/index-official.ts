/**
 * Embeds data/official.jsonl into data/official-index (same providers and flags as `npm run index`).
 *   npm run index:official                 embed what changed
 *   npm run index:official -- --no-embed   keyword-only
 */
import path from 'node:path';
import { embedderFromEnv, PROVIDER_LABELS } from '../lib/embeddings.ts';
import { loadDotEnv } from '../lib/env.ts';
import { buildOfficialIndex, officialFile, officialIndexDir } from '../lib/official.ts';

loadDotEnv();
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const embedder = flag('no-embed') ? null : embedderFromEnv(process.env, value('provider'));
if (!flag('no-embed') && !embedder) {
  console.error('No embedding key found (VOYAGE_API_KEY, CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID, or GEMINI_API_KEY); pass --no-embed for a keyword-only index.');
  process.exit(1);
}
if (embedder) console.log(`[official-index] Embedding with ${PROVIDER_LABELS[embedder.provider]} (${embedder.model}, ${embedder.dimensions} dims).`);
buildOfficialIndex({ file: officialFile(), outDir: officialIndexDir(), embedder, batchSize: Number(value('batch')) || undefined, concurrency: Number(value('concurrency')) || undefined, log: (message) => console.log(`[official-index] ${message}`) })
  .then((result) => console.log(`[official-index] Done: ${result.docs} pages, ${result.chunks} chunks, ${result.embedded} embedded, ${result.reused} reused. Index in ${path.relative(process.cwd(), officialIndexDir())}/.`))
  .catch((error) => {
    console.error('[official-index] Failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
