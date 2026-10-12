import { randomUUID } from 'node:crypto';
import { emailAdmins } from '../lib/admin.ts';
import { emailSession } from '../lib/auth.ts';
import { ApiError, rateLimit, readJson, route, sendJson } from '../lib/http.ts';

export default route(['POST'], async (req, res) => {
  const session = emailSession(req);
  if (!session) throw new ApiError(401, 'Sign in to send feedback.', 'login_required');

  const body = await readJson<{ message?: unknown; page?: unknown }>(req);
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message || message.length > 2000) throw new ApiError(400, 'Feedback must be between 1 and 2000 characters.', 'bad_feedback');
  const page = typeof body.page === 'string' && /^\/(?!\/)[^\r\n?]{0,199}$/.test(body.page) ? body.page : '/';

  rateLimit(req, 3, 3 / 60, 'feedback', session.netId);
  await emailAdmins(
    'nyuad.life: student feedback',
    `From: ${session.netId}@nyu.edu\nPage: ${page}\n\n${message}`,
    `feedback-${randomUUID()}`,
  );
  sendJson(res, 200, { ok: true });
});
