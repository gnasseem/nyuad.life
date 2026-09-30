import { boardStore, type BoardCheck, type BoardStore } from '../lib/board-store.ts';
import { embedderForIndex, keysFor, providerForModel } from '../lib/embeddings.ts';
import { geminiConfig } from '../lib/gemini.ts';
import { route, sendJson } from '../lib/http.ts';
import { loadOfficial } from '../lib/official.ts';
import { loadArchive } from '../lib/store.ts';

/** The board probe costs two database calls, so its result is kept for a while: five minutes when fine, half a minute when not. */
let boardProbe: { at: number; result: BoardCheck } | undefined;

async function boardHealth(board: BoardStore | null): Promise<Record<string, unknown>> {
  if (!board) return { configured: false, ok: false, hint: 'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see supabase/schema.sql) to enable the board.' };
  const now = Date.now();
  if (!boardProbe || now - boardProbe.at > (boardProbe.result.ok ? 300_000 : 30_000)) {
    boardProbe = { at: now, result: await board.check() };
  }
  const { ok, code, problem } = boardProbe.result;
  return { configured: true, persistent: board.persistent, ok, ...(ok ? {} : { code, problem }) };
}

export default route(['GET'], async (_req, res) => {
  const cfg = geminiConfig();
  const board = boardStore();
  let archive: Awaited<ReturnType<typeof loadArchive>> | undefined;
  let archiveError = '';
  try {
    archive = await loadArchive();
  } catch (error) {
    archiveError = (error as Error).message;
  }
  const official = await loadOfficial().catch(() => null);
  const provider = archive ? (archive.meta.provider ?? providerForModel(archive.meta.model)) : null;
  const queryEmbedder = archive ? embedderForIndex(archive.meta) : null;
  sendJson(res, archive ? 200 : 503, {
    ok: Boolean(archive && cfg),
    archive: archive
      ? {
          source: archive.source,
          posts: archive.posts.length,
          comments: archive.meta.comments,
          chunks: archive.chunks.length,
          vectors: archive.vectors.count > 0,
          model: archive.meta.model,
          dimensions: archive.meta.dimensions,
          builtAt: archive.meta.builtAt,
          newestPost: archive.meta.newestPost,
          oldestPost: archive.meta.oldestPost,
          loadMs: archive.loadMs,
        }
      : { error: archiveError },
    // Semantic search needs vectors in the index AND the key of the provider that made them, to embed questions.
    embeddings: archive
      ? {
          provider,
          model: archive.meta.model,
          keyConfigured: Boolean(queryEmbedder),
          semanticSearch: archive.vectors.count > 0 && Boolean(queryEmbedder),
          hint: archive.vectors.count === 0 ? 'The index has no vectors yet; run the Build search index workflow.' : queryEmbedder ? undefined : `Set ${provider ? keysFor(provider) : 'the embedding key'} on the server to enable semantic search.`,
        }
      : undefined,
    // Official NYUAD pages: crawled by the "Crawl official NYUAD pages" workflow into data/official.jsonl.
    official: official && official.docs.length ? { pages: official.docs.length, courses: official.byCode.size, chunks: official.chunks.length, vectors: official.vectors.count > 0, fetchedAt: official.meta.newestPost, source: official.source } : { pages: 0, hint: 'Run the "Crawl official NYUAD pages" workflow (or npm run scrape:official && npm run index:official) to add official pages.' },
    gemini: cfg ? { configured: true, chatModel: cfg.chatModel, chatFallbacks: cfg.chatFallbacks, liteModel: cfg.liteModel } : { configured: false },
    // The board needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in production; locally it runs in memory. `ok` comes
    // from a real probe, so a schema that was never run or a wrong key shows up here instead of as a vague error.
    board: await boardHealth(board),
  });
});
