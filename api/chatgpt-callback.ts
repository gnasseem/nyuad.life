/**
 * Where ChatGPT sends the student back after they allow the connection. Register this URL with OpenAI as the redirect
 * URI: https://<your domain>/api/chatgpt-callback. Trades the code for tokens, keeps them in a sealed cookie and returns
 * the student to where they started, with ?chatgpt=connected or ?chatgpt=error&reason=… for the page to show.
 */
import { addCookies, chatgptConfig, ChatGPTError, completeLogin, sessionCookies } from '../lib/chatgpt.ts';
import { route } from '../lib/http.ts';

function redirect(res: Parameters<Parameters<typeof route>[1]>[1], to: string): void {
  res.statusCode = 302;
  res.setHeader('location', to);
  res.setHeader('cache-control', 'no-store');
  res.end();
}

function withParams(path: string, params: Record<string, string>): string {
  const url = new URL(path, 'http://site');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  // A path that normalised to "//host" would leave the site; send it home instead.
  return url.origin === 'http://site' && !url.pathname.startsWith('//') ? `${url.pathname}${url.search}` : `/${url.search}`;
}

export default route(['GET'], async (req, res) => {
  const cfg = chatgptConfig();
  if (!cfg) return redirect(res, '/?chatgpt=error&reason=off');
  const query = new URL(req.url ?? '/', 'http://site').searchParams;
  try {
    const { session, returnTo, clearLogin } = await completeLogin(cfg, req, query);
    addCookies(res, [clearLogin, ...sessionCookies(cfg, req, session)]);
    redirect(res, withParams(returnTo, { chatgpt: 'connected' }));
  } catch (error) {
    const reason = error instanceof ChatGPTError ? error.code : 'chatgpt_error';
    if (!(error instanceof ChatGPTError) || error.status >= 500) console.error('[chatgpt] sign-in failed:', error);
    redirect(res, withParams('/', { chatgpt: 'error', reason }));
  }
});
