import { boardStore } from '../lib/board-store.ts';
import { addCookies, chatgptConfig, ChatGPTError, freshSession, readSession, sessionCookies } from '../lib/chatgpt.ts';
import { geminiConfig } from '../lib/gemini.ts';
import { ApiError, rateLimit, readJson, route, sendJson, startSse } from '../lib/http.ts';
import { loadOfficial } from '../lib/official.ts';
import { ask, validateAsk } from '../lib/rag.ts';
import { loadArchive } from '../lib/store.ts';
import type { AskRequest } from '../lib/types.ts';

export const config = { maxDuration: 60 };

/** Vercel stops the function at 60 s from the request, cold start included; the answer has to end before that. */
const DEADLINE_MS = 54_000;

export default route(['POST'], async (req, res) => {
  const deadline = Date.now() + DEADLINE_MS;
  rateLimit(req, 12, 10, 'ask');
  const cfg = geminiConfig();
  const request = validateAsk(await readJson<Partial<AskRequest>>(req));

  // A student who connected ChatGPT is answered on their own plan. Their token is refreshed here, before anything is
  // streamed, because a cookie can only be set while the response headers are still open.
  const chatgptCfg = chatgptConfig();
  const stored = chatgptCfg ? readSession(chatgptCfg, req) : null;
  let chatgpt: { cfg: NonNullable<typeof chatgptCfg>; token: string } | null = null;
  if (chatgptCfg && stored) {
    try {
      const { session, changed } = await freshSession(chatgptCfg, stored);
      if (changed) addCookies(res, sessionCookies(chatgptCfg, req, session));
      chatgpt = { cfg: chatgptCfg, token: session.access };
    } catch (error) {
      if (error instanceof ChatGPTError && error.code === 'chatgpt_expired') addCookies(res, sessionCookies(chatgptCfg, req, null));
      if (error instanceof ChatGPTError) throw new ApiError(error.status, error.message, error.code);
      throw error;
    }
  }
  if (!chatgpt && chatgptCfg && (chatgptCfg.required || !cfg)) throw new ApiError(401, 'Connect your ChatGPT account to ask. Answers run on your own plan.', 'chatgpt_required');
  if (!chatgpt && !cfg) throw new ApiError(503, 'GEMINI_API_KEY is not set on the server.', 'no_model');
  const archive = await loadArchive();
  const official = await loadOfficial().catch((error) => {
    console.warn('[ask] official pages could not be loaded:', (error as Error).message);
    return null;
  });
  const board = boardStore();

  if (!request.stream) {
    sendJson(res, 200, await ask(archive, cfg, request, {}, undefined, { board, official, deadline, chatgpt }));
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
      { board, official, deadline, chatgpt },
    );
    sse.send('done', { model: result.model, confidence: result.confidence, truncated: result.truncated ?? false, retrieval: result.retrieval });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!(error instanceof ApiError) || error.status >= 500) console.error('[ask]', error);
    sse.send('error', { message, code: error instanceof ApiError ? error.code : 'error' });
  } finally {
    sse.close();
  }
});
