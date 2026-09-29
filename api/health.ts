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
    gemini: cfg ? { configured: true, chatModel: cfg.chatModel, liteModel: cfg.liteModel, embedModel: cfg.embedModel } : { configured: false },
  });
});
