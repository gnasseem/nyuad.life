import { randomUUID } from 'node:crypto';
import { emailAdmins } from '../lib/admin.ts';
import { isAskLogKey, markAskLog } from '../lib/app-usage.ts';
import { emailSession } from '../lib/auth.ts';
import { boardStore } from '../lib/board-store.ts';
import { ApiError, rateLimit, readJson, route, sendJson } from '../lib/http.ts';

export default route(['POST'], async (req, res) => {
  const body = await readJson<{ message?: unknown; page?: unknown; kind?: unknown; question?: unknown; answer?: unknown; sources?: unknown; logId?: unknown; vote?: unknown; asked?: unknown; rating?: unknown }>(req);
  // What a student did with an Ask answer (thumbs, or putting the question to students), for the admins' Ask log.
  if (body.kind === 'ask-mark') {
    rateLimit(req, 30, 30 / 60, 'ask-mark');
    if (!isAskLogKey(body.logId)) throw new ApiError(400, 'Unknown answer.', 'bad_mark');
    const store = boardStore();
    if (!store?.persistent) { sendJson(res, 200, { ok: false }); return; }
    const marks = { ...(body.vote === 'up' || body.vote === 'down' || body.vote === null ? { vote: body.vote as 'up' | 'down' | null } : {}), ...(body.asked === true ? { asked: true } : {}) };
    if (!Object.keys(marks).length) throw new ApiError(400, 'Nothing to mark.', 'bad_mark');
    sendJson(res, 200, { ok: await markAskLog(store, body.logId, marks) });
    return;
  }
  if (body.kind === 'ask-report') {
    rateLimit(req, 5, 1, 'ask-report');
    const question = typeof body.question === 'string' ? body.question.trim().slice(0, 1200) : '';
    const answer = typeof body.answer === 'string' ? body.answer.trim().slice(0, 8000) : '';
    const reason = typeof body.message === 'string' ? body.message.trim().slice(0, 1000) : '';
    const sources = Array.isArray(body.sources) ? body.sources.filter((value): value is string => typeof value === 'string' && /^https?:\/\//.test(value)).slice(0, 12) : [];
    if (!question || !answer || !reason) throw new ApiError(400, 'Add a reason for reporting this answer.', 'bad_report');
    const store = boardStore();
    if (!store?.persistent && process.env.VERCEL === '1') throw new ApiError(503, 'Reports are unavailable right now.', 'reports_unavailable');
    if (!store) throw new ApiError(503, 'Reports are unavailable right now.', 'reports_unavailable');
    await store.putSummary(`ask-report:${randomUUID()}`, { question, answer, reason, sources });
    if (isAskLogKey(body.logId)) await markAskLog(store, body.logId, { reported: true }).catch(() => undefined);
    sendJson(res, 200, { ok: true });
    return;
  }
  const session = emailSession(req);
  if (!session) throw new ApiError(401, 'Sign in to send feedback.', 'login_required');
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message || message.length > 2000) throw new ApiError(400, 'Feedback must be between 1 and 2000 characters.', 'bad_feedback');
  const page = typeof body.page === 'string' && /^\/(?!\/)[^\r\n?]{0,199}$/.test(body.page) ? body.page : '/';

  // From the review card: how useful the site is, 1 to 5.
  const rating = typeof body.rating === 'number' && Number.isInteger(body.rating) && body.rating >= 1 && body.rating <= 5 ? body.rating : null;

  rateLimit(req, 3, 3 / 60, 'feedback', session.netId);
  await emailAdmins(
    rating ? `nyuad.life: site review, ${rating}/5` : 'nyuad.life: student feedback',
    `From: ${session.netId}@nyu.edu\nPage: ${page}${rating ? `\nRating: ${rating}/5` : ''}\n\n${message}`,
    `feedback-${randomUUID()}`,
  );
  sendJson(res, 200, { ok: true });
});
