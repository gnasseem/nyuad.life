import { embedderForIndex, keysFor, providerForModel } from '../lib/embeddings.ts';
import { geminiConfig } from '../lib/gemini.ts';
import { route, sendJson } from '../lib/http.ts';
import { loadArchive } from '../lib/store.ts';

export default route(['GET'], async (_req, res) => {
  const cfg = geminiConfig();
  let archive: Awaited<ReturnType<typeof loadArchive>> | undefined;
  let archiveError = '';
  try {
    archive = await loadArchive();
  } catch (error) {
    archiveError = (error as Error).message;
  }
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
    gemini: cfg ? { configured: true, chatModel: cfg.chatModel, chatFallbacks: cfg.chatFallbacks, liteModel: cfg.liteModel } : { configured: false },
  });
});
