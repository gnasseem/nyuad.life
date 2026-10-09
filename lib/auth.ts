/** Email verification and encrypted sessions; the shared account key keeps posts owned across devices. */
import { createHash, createHmac, randomInt } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { addCookies, readCookies, seal, unseal } from './chatgpt.ts';
import { ApiError } from './http.ts';
import { validateNetId } from './board.ts';
import type { BoardStore } from './board-store.ts';

const COOKIE = 'nyuad_session';
const SESSION_MS = 30 * 24 * 60 * 60_000;
export interface EmailSession { netId: string; key: string; exp: number }
function secret(): Buffer {
  const value = process.env.SESSION_SECRET ?? '';
  if (value.length < 32) throw new ApiError(503, 'Email login needs a SESSION_SECRET of at least 32 characters.', 'auth_unavailable');
  return createHash('sha256').update(`nyuad-email:${value}`).digest();
}
export function accountKey(netId: string): string {
  return createHmac('sha256', secret()).update(`account:${netId}`).digest('hex');
}
export function otpDigest(netId: string, code: string): string {
  return createHmac('sha256', secret()).update(`otp:${netId}:${code}`).digest('hex');
}
export function emailNetId(input: unknown): string {
  const value = String(input ?? '').trim().toLowerCase();
  if (value.includes('@') && !/^[a-z]+\d+@nyu\.edu$/.test(value)) throw new ApiError(400, 'Use your NetID email address, such as abc1234@nyu.edu.', 'bad_email');
  return validateNetId(value.replace(/@nyu\.edu$/, ''));
}
export function emailSession(req: IncomingMessage): EmailSession | null {
  const token = readCookies(req).get(COOKIE);
  if (!token) return null;
  try {
    const session = unseal<EmailSession>(secret(), token);
    return session && /^[a-z]{1,8}\d{1,6}$/.test(session.netId) && /^[a-f0-9]{64}$/.test(session.key) && session.exp > Date.now() ? session : null;
  } catch { return null; }
}
export function requireEmailSession(req: IncomingMessage): EmailSession {
  const session = emailSession(req);
  if (!session) throw new ApiError(401, 'Log in with the code sent to your NYU email.', 'signup_required');
  return session;
}
export function setEmailSession(req: IncomingMessage, res: ServerResponse, netId: string): string {
  const key = accountKey(netId);
  addCookies(res, [cookie(req, seal(secret(), { netId, key, exp: Date.now() + SESSION_MS }), SESSION_MS / 1000)]);
  return key;
}
export function clearEmailSession(req: IncomingMessage, res: ServerResponse): void { addCookies(res, [cookie(req, '', 0)]); }
function cookie(req: IncomingMessage, value: string, seconds: number): string {
  const secure = process.env.VERCEL === '1' || req.headers['x-forwarded-proto'] === 'https';
  return `${COOKIE}=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${seconds}${secure ? '; Secure' : ''}`;
}
export async function sendLoginCode(store: BoardStore, netId: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!apiKey || !from) throw new ApiError(503, 'Email login is not configured yet. Set RESEND_API_KEY and RESEND_FROM.', 'auth_unavailable');
  const code = String(randomInt(100000, 1000000));
  const digest = otpDigest(netId, code);
  if (!await store.reserveOtp(netId, digest)) throw new ApiError(429, 'Wait a minute before requesting another code. You can request five per hour.', 'otp_rate_limit');
  let response: Response;
  try {
    response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'idempotency-key': `login-${netId}-${digest}` }, body: JSON.stringify({ from, to: [`${netId}@nyu.edu`], subject: 'Your nyuad.life login code', text: `Your nyuad.life verification code is ${code}. It expires in 10 minutes. If you did not request it, ignore this email.` }), signal: AbortSignal.timeout(12_000) });
  } catch { throw new ApiError(503, 'Could not send your code. Wait a minute and try again.', 'email_failed'); }
  if (!response.ok) throw new ApiError(503, 'Could not send your code. Wait a minute and try again.', 'email_failed');
}
