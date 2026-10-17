import { alertModelsDown } from '../lib/admin.ts';
import { recordEvent, recordQuestion } from '../lib/app-usage.ts';
import { boardStore } from '../lib/board-store.ts';
import { addCookies, chatgptConfig, ChatGPTError, freshSession, readSession, sessionCookies } from '../lib/chatgpt.ts';
import { geminiConfig } from '../lib/gemini.ts';
import { ApiError, rateLimit, readJson, route, sendJson, startSse } from '../lib/http.ts';
import { limitDurably, requireMember } from '../lib/identity.ts';
import { loadOfficial } from '../lib/official.ts';
import { providersFromEnv, warmModels } from '../lib/providers.ts';
import { loadCatalog } from '../lib/courses.ts';
import { ask, validateAsk, warmBoard } from '../lib/rag.ts';
import { loadArchive } from '../lib/store.ts';
import type { AskRequest, AskResponse } from '../lib/types.ts';

export const config = { maxDuration: 60 };

/** Vercel stops the function at 60 s from the request, cold start included; the answer has to end before that. */
const DEADLINE_MS = 54_000;
/** Errors that mean every model in the chain failed: the administrators are emailed (lib/admin.ts). */
const MODELS_DOWN = new Set(['quota', 'busy', 'model_error']);

export default route(['GET', 'POST'], async (req, res) => {
  // The Ask page calls this when it opens: the instance reads the archive, the official pages, the schedule and the
  // board while the student types, so the question does not wait for a cold start. Nothing is answered.
  if (req.method === 'GET') {
    rateLimit(req, 30, 30 / 60, 'ask-warm');
    const started = Date.now();
    warmBoard(boardStore());
    await Promise.all([warmModels().catch(() => undefined), loadArchive(), loadOfficial().catch(() => null)]);
    loadCatalog();
    sendJson(res, 200, { ok: true, ms: Date.now() - started });
    return;
  }
  const deadline = Date.now() + DEADLINE_MS;
  // Per address only loosely: a campus or a phone network puts many students behind one. The real limits are per
  // student, below, once the request is known to come from one.
  rateLimit(req, 40, 30, 'ask');
  const request = validateAsk(await readJson<Partial<AskRequest>>(req));
  // Answers cost model calls: only students who signed up get them. Meanwhile the model lists are checked against
  // what the keys can use (cached for hours, so this is free after an instance's first question).
  const warming = warmModels().catch(() => undefined);
  const member = await requireMember(req);
  if (member) {
    rateLimit(req, 10, 6, 'ask-student', member.netId);
    // A daily ceiling per student across every instance, so one account cannot spend the free quota everyone shares.
    await limitDurably(boardStore(), `ask:${member.netId}`, 150, 86_400, 'You have asked a lot today. Ask again tomorrow, or ask other students on Questions.');
  } else {
    rateLimit(req, 150, 150 / 1440, 'ask-day');
  }
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
  // Both are read from disk once per instance; on a cold start they load side by side.
  const [archive, official] = await Promise.all([
    loadArchive(),
    loadOfficial().catch((error) => {
      console.warn('[ask] official pages could not be loaded:', (error as Error).message);
      return null;
    }),
  ]);
  const board = boardStore();
  // Saving the answer to the cache happens after the student has it; the function stays up until it is done.
  const deferred: Array<Promise<unknown>> = [warming];
  const defer = (work: Promise<unknown>) => void deferred.push(work.catch(() => undefined));
  const noteQuestion = (result: AskResponse) => {
    if (result.screened || result.redirect) return;
    defer(recordQuestion(board, {
      question: request.question,
      followUp: (request.history?.length ?? 0) > 0,
      model: result.model,
      confidence: result.confidence?.level ?? '',
      sources: [...new Set(result.sources.map((card) => card.kind))],
      cached: result.cached ?? false,
      missing: /couldn[’']t (?:confirm|find|verify)|do(?:es)? not (?:contain|specify|state|provide|mention)|no (?:information|evidence)/i.test(result.answer.slice(0, 200)),
      firstMs: result.timings?.first,
    }));
  };
  const noteFailure = (error: unknown) => {
    if (!(error instanceof ApiError) || !MODELS_DOWN.has(error.code)) return;
    recordEvent('ask_failed');
    defer(alertModelsDown(error.message));
  };

  if (!request.stream) {
    try {
      const result = await ask(archive, cfg, request, {}, undefined, { board, official, deadline, chatgpt, backups, defer });
      console.info(`[ask] model=${result.model} cached=${Boolean(result.cached)} truncated=${Boolean(result.truncated)} sources=${result.sources.length}`);
      recordEvent(result.cached ? 'ask_cached' : 'ask');
      noteQuestion(result);
      sendJson(res, 200, result);
    } catch (error) {
      noteFailure(error);
      throw error;
    } finally {
      await Promise.all(deferred);
    }
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
        replace: (text) => sse.send('replace', { text }),
      },
      controller.signal,
      { board, official, deadline, chatgpt, backups, defer },
    );
    console.info(`[ask] model=${result.model} cached=${Boolean(result.cached)} truncated=${Boolean(result.truncated)} sources=${result.sources.length}`);
    recordEvent(result.cached ? 'ask_cached' : 'ask');
    noteQuestion(result);
    sse.send('done', { model: result.model, confidence: result.confidence, truncated: result.truncated ?? false, cached: result.cached ?? false, retrieval: result.retrieval });
  } catch (error) {
    noteFailure(error);
    if (!(error instanceof ApiError) || error.status >= 500) console.error('[ask]', error);
    // Only our own errors are worded for students; anything else ("Gemini 503: …") stays in the log.
    const message = error instanceof ApiError ? error.message : 'Something went wrong while answering. Try again in a moment.';
    sse.send('error', { message, code: error instanceof ApiError ? error.code : 'error' });
  } finally {
    sse.close();
    await Promise.all(deferred);
  }
});
