import { boardStore, type BoardCheck, type BoardStore } from '../lib/board-store.ts';
import { embedderForIndex, keysFor, providerForModel } from '../lib/embeddings.ts';
import { chatgptConfig } from '../lib/chatgpt.ts';
import { loadCatalog } from '../lib/courses.ts';
import { geminiConfig } from '../lib/gemini.ts';
import { route, sendJson } from '../lib/http.ts';
import { loadOfficial } from '../lib/official.ts';
import { rerankerFromEnv } from '../lib/rerank.ts';
import { loadArchive } from '../lib/store.ts';

/** The board probe costs two database calls, so its result is kept for a while: five minutes when fine, half a minute when not. */
let boardProbe: { at: number; result: BoardCheck } | undefined;

async function boardHealth(board: BoardStore | null): Promise<Record<string, unknown>> {
  if (!board) return { configured: false, ok: false, hint: 'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to enable the board.' };
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
  const catalog = (() => {
    try {
      return loadCatalog();
    } catch {
      return null;
    }
  })();
  const reranker = rerankerFromEnv();
  const chatgpt = chatgptConfig();
  sendJson(res, archive ? 200 : 503, {
    ok: Boolean(archive && (cfg || chatgpt)),
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
          hint: archive.vectors.count === 0 ? 'Run the Build search index workflow to add vectors.' : queryEmbedder ? undefined : `Set ${provider ? keysFor(provider) : 'the embedding key'} on the server to enable semantic search.`,
        }
      : undefined,
    // Official NYUAD pages: crawled by the "Crawl official NYUAD pages" workflow into data/official.jsonl.
    official: official && official.docs.length ? { pages: official.docs.length, courses: official.byCode.size, chunks: official.chunks.length, vectors: official.vectors.count > 0, fetchedAt: official.meta.newestPost, source: official.source } : { pages: 0, hint: 'Run the Crawl official NYUAD pages workflow to add official pages.' },
    // The class schedule from Albert: scraped on a laptop with npm run scrape:albert into data/classes.jsonl.
    classes: catalog && catalog.byCode.size ? { courses: catalog.byCode.size, terms: catalog.terms.map((term) => term.name), current: catalog.current, scraped: catalog.scraped } : { courses: 0, hint: 'Run npm run scrape:albert and commit data/classes.jsonl.' },
    // Sources are reranked by a cross-encoder when VOYAGE_API_KEY is set, else by the lite Gemini model.
    reranker: reranker ? { model: reranker.name } : { model: null, hint: 'Set VOYAGE_API_KEY for better source ranking.' },
    // Sign in with ChatGPT: students' answers run on their own plan. Needs OPENAI_CLIENT_ID and SESSION_SECRET.
    chatgpt: chatgpt ? { available: true, required: chatgpt.required, chatModels: chatgpt.chatModels, liteModels: chatgpt.liteModels, siteUrl: chatgpt.siteUrl || null } : { available: false, hint: 'Set OPENAI_CLIENT_ID and SESSION_SECRET to let students answer on their own ChatGPT plan.' },
    gemini: cfg ? { configured: true, chatModel: cfg.chatModel, chatFallbacks: cfg.chatFallbacks, liteModel: cfg.liteModel, liteModels: cfg.liteModels } : { configured: false },
    // The board needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in production; locally it runs in memory. `ok` comes
    // from a real probe, so a schema that was never run or a wrong key shows up here instead of as a vague error.
    board: await boardHealth(board),
  });
});
