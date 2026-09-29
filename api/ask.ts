import { geminiConfig } from '../lib/gemini.ts';
import { ApiError, rateLimit, readJson, requireAccess, route, sendJson, startSse } from '../lib/http.ts';
import { ask, validateAsk } from '../lib/rag.ts';
import { loadArchive } from '../lib/store.ts';
import type { AskRequest } from '../lib/types.ts';

export const config = { maxDuration: 60 };

export default route(['POST'], async (req, res) => {
  requireAccess(req);
  rateLimit(req, 12, 10);
  const cfg = geminiConfig();
  if (!cfg) throw new ApiError(503, 'GEMINI_API_KEY is not configured on the server.', 'no_model');
  const request = validateAsk(await readJson<Partial<AskRequest>>(req));
  const archive = await loadArchive();

  if (!request.stream) {
    sendJson(res, 200, await ask(archive, cfg, request));
    return;
  }

  const sse = startSse(req, res);
  const controller = new AbortController();
  req.on('close', () => controller.abort());
  try {
    const result = await ask(
      archive,
      cfg,
      request,
      {
        status: (message) => sse.send('status', { message }),
        sources: (sources) => sse.send('sources', { sources }),
        delta: (text) => sse.send('delta', { text }),
        followups: (questions) => sse.send('followups', { questions }),
      },
      controller.signal,
    );
    sse.send('done', { model: result.model, retrieval: result.retrieval });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!(error instanceof ApiError) || error.status >= 500) console.error('[ask]', error);
    sse.send('error', { message });
  } finally {
    sse.close();
  }
});
