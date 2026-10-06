import { boardStore } from '../lib/board-store.ts';
import { addCookies, chatgptConfig, ChatGPTError, freshSession, readSession, sessionCookies } from '../lib/chatgpt.ts';
import { geminiConfig } from '../lib/gemini.ts';
import { ApiError, rateLimit, readJson, route, sendJson, startSse } from '../lib/http.ts';
import { requireMember } from '../lib/identity.ts';
import { loadOfficial } from '../lib/official.ts';
import { providersFromEnv, warmModels } from '../lib/providers.ts';
import { ask, validateAsk } from '../lib/rag.ts';
import { loadArchive } from '../lib/store.ts';
import type { AskRequest } from '../lib/types.ts';

export const config = { maxDuration: 60 };

/** Vercel stops the function at 60 s from the request, cold start included; the answer has to end before that. */
const DEADLINE_MS = 54_000;

export default route(['POST'], async (req, res) => {
  const deadline = Date.now() + DEADLINE_MS;
  rateLimit(req, 12, 10, 'ask');
  // And a daily ceiling per address, so one client cannot spend the free model quota everyone shares.
  rateLimit(req, 150, 150 / 1440, 'ask-day');
  const request = validateAsk(await readJson<Partial<AskRequest>>(req));
  // Answers cost model calls: only students who signed up get them. Meanwhile the model lists are checked against
  // what the keys can use (cached for hours, so this is free after an instance's first question).
  await Promise.all([requireMember(req), warmModels()]);
  const cfg = geminiConfig();

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
  const backups = providersFromEnv();
  if (!chatgpt && chatgptCfg && (chatgptCfg.required || (!cfg && backups.length === 0))) throw new ApiError(401, 'Connect your ChatGPT account to ask. Answers run on your own plan.', 'chatgpt_required');
  if (!chatgpt && !cfg && backups.length === 0) throw new ApiError(503, 'No model key is set on the server (GEMINI_API_KEY, GROQ_API_KEY, …).', 'no_model');
  const archive = await loadArchive();
  const official = await loadOfficial().catch((error) => {
    console.warn('[ask] official pages could not be loaded:', (error as Error).message);
    return null;
  });
  const board = boardStore();
  // Saving the answer to the cache happens after the student has it; the function stays up until it is done.
  const deferred: Array<Promise<unknown>> = [];
  const defer = (work: Promise<unknown>) => void deferred.push(work.catch(() => undefined));

  if (!request.stream) {
    sendJson(res, 200, await ask(archive, cfg, request, {}, undefined, { board, official, deadline, chatgpt, backups, defer }));
    await Promise.all(deferred);
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
      },
      controller.signal,
      { board, official, deadline, chatgpt, backups, defer },
    );
    sse.send('done', { model: result.model, confidence: result.confidence, truncated: result.truncated ?? false, cached: result.cached ?? false, retrieval: result.retrieval });
  } catch (error) {
    if (!(error instanceof ApiError) || error.status >= 500) console.error('[ask]', error);
    // Only our own errors are worded for students; anything else ("Gemini 503: …") stays in the log.
    const message = error instanceof ApiError ? error.message : 'Something went wrong while answering. Try again in a moment.';
    sse.send('error', { message, code: error instanceof ApiError ? error.code : 'error' });
  } finally {
    sse.close();
    await Promise.all(deferred);
  }
});
