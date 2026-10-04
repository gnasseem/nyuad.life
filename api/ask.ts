import { boardStore } from '../lib/board-store.ts';
import { geminiConfig } from '../lib/gemini.ts';
import { ApiError, rateLimit, readJson, route, sendJson, startSse } from '../lib/http.ts';
import { loadOfficial } from '../lib/official.ts';
import { ask, validateAsk } from '../lib/rag.ts';
import { loadArchive } from '../lib/store.ts';
import type { AskRequest } from '../lib/types.ts';

export const config = { maxDuration: 60 };

export default route(['POST'], async (req, res) => {
  rateLimit(req, 12, 10, 'ask');
  const cfg = geminiConfig();
  if (!cfg) throw new ApiError(503, 'GEMINI_API_KEY is not set on the server.', 'no_model');
  const request = validateAsk(await readJson<Partial<AskRequest>>(req));
  const archive = await loadArchive();
  const official = await loadOfficial().catch((error) => {
    console.warn('[ask] official pages could not be loaded:', (error as Error).message);
    return null;
  });
  const board = boardStore();

  if (!request.stream) {
    sendJson(res, 200, await ask(archive, cfg, request, {}, undefined, { board, official }));
    return;
  }

  const sse = startSse(req, res);
  const controller = new AbortController();
  // The response closing before it finished means the student stopped or left: stop generating. (The request's own
  // 'close' fires as soon as its body has been read, so it cannot tell.)
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  try {
    const result = await ask(
      archive,
      cfg,
      request,
      {
        status: (message) => sse.send('status', { message }),
        redirect: (redirect) => sse.send('redirect', redirect),
        sources: (sources) => sse.send('sources', { sources }),
        delta: (text) => sse.send('delta', { text }),
        followups: (questions) => sse.send('followups', { questions }),
      },
      controller.signal,
      { board, official },
    );
    sse.send('done', { model: result.model, confidence: result.confidence, truncated: result.truncated ?? false, retrieval: result.retrieval });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!(error instanceof ApiError) || error.status >= 500) console.error('[ask]', error);
    sse.send('error', { message });
  } finally {
    sse.close();
  }
});
