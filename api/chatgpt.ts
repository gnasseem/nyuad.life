/**
 * Sign in with ChatGPT, so a student's answers run on their own ChatGPT plan (lib/chatgpt.ts).
 *
 *   GET  /api/chatgpt?op=start[&returnTo=/path]   redirects to ChatGPT to connect
 *   GET  /api/chatgpt?op=me                        whether the feature is on, and who is connected
 *   POST /api/chatgpt { op: "logout" }             forgets the connection on this browser
 */
import { addCookies, beginLogin, chatgptConfig, readSession, sessionCookies } from '../lib/chatgpt.ts';
import { ApiError, queryString, rateLimit, readJson, route, sendJson } from '../lib/http.ts';

export default route(['GET', 'POST'], async (req, res) => {
  const cfg = chatgptConfig();
  const op = req.method === 'POST' ? String((await readJson<{ op?: string }>(req)).op ?? '') : queryString(req, 'op');
  if (op === 'me') {
    const session = cfg ? readSession(cfg, req) : null;
    sendJson(res, 200, { available: Boolean(cfg), required: cfg?.required ?? false, connected: Boolean(session), name: session?.name ?? '', email: session?.email ?? '', plan: session?.plan ?? '' });
    return;
  }
  if (!cfg) throw new ApiError(404, 'Sign in with ChatGPT is not set up on this server.', 'chatgpt_off');
  if (op === 'start' && req.method === 'GET') {
    rateLimit(req, 10, 5, 'chatgpt-login');
    const { url, cookie } = beginLogin(cfg, req, queryString(req, 'returnTo'));
    addCookies(res, [cookie]);
    res.statusCode = 302;
    res.setHeader('location', url);
    res.setHeader('cache-control', 'no-store');
    res.end();
    return;
  }
  if (op === 'logout' && req.method === 'POST') {
    addCookies(res, sessionCookies(cfg, req, null));
    sendJson(res, 200, { ok: true });
    return;
  }
  throw new ApiError(400, 'Unknown op.', 'bad_op');
});
