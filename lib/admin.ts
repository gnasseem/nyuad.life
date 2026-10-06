/**
 * Admin mode. Whoever knows ROR_ADMIN_CODE (set on Vercel, at least 12 characters, ideally 32 random ones) can turn
 * it on from Settings and then remove any post and bar a NetID from posting.
 *
 * The code is compared in constant time, after hashing, so neither its length nor its prefix leaks. Wrong codes are
 * counted in the database (admin_attempts), per address and across the site, so the limit holds across serverless
 * instances and cold starts: 5 wrong codes from an address lock it out for 15 minutes, and 25 in a day lock everyone
 * out until the day is over. The lock is checked before the code, and a locked-out caller gets the same answer as a
 * wrong code. A right code sets an encrypted, HttpOnly, SameSite=Strict cookie that expires after an hour, checked on
 * every admin request; changing the code ends every admin session at once.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { MemoryBoardStore, type BoardStore } from './board-store.ts';
import { addCookies, readCookies, seal, unseal } from './chatgpt.ts';
import { ApiError, clientIp, clientKey } from './http.ts';

const COOKIE = 'ror_admin';
const SESSION_MS = 60 * 60_000;
export const MIN_CODE_LENGTH = 12;
const PER_ADDRESS = { max: 5, windowMs: 15 * 60_000 };
const SITE_WIDE = { max: 25, windowMs: 24 * 3_600_000 };

interface AdminConfig {
  digest: Buffer;
  key: Buffer;
}

interface AdminSession {
  role: 'admin';
  exp: number;
  jti: string;
}

/** The admin settings, or null when admin mode is off (no code, or one too short to be safe). */
export function adminConfig(env: NodeJS.ProcessEnv = process.env): AdminConfig | null {
  const code = (env.ROR_ADMIN_CODE ?? '').trim();
  if (code.length < MIN_CODE_LENGTH) {
    if (code) console.warn(`[admin] ROR_ADMIN_CODE is shorter than ${MIN_CODE_LENGTH} characters, so admin mode is off.`);
    return null;
  }
  return {
    digest: createHash('sha256').update(code).digest(),
    // The code is part of the key: a new code makes every cookie sealed with the old one unreadable.
    key: createHash('sha256').update(`ror-admin-session:${env.SESSION_SECRET ?? ''}:${code}`).digest(),
  };
}

/** Constant-time: both sides are hashed first, so the lengths always match and nothing about the code leaks. */
export function codeMatches(cfg: AdminConfig, attempt: string): boolean {
  return timingSafeEqual(createHash('sha256').update(attempt.trim().slice(0, 256)).digest(), cfg.digest);
}

function buckets(req: IncomingMessage): string[] {
  return [`ip:${clientKey(clientIp(req))}`, 'global'];
}

/** Counts kept on this instance only, for a database without the admin_attempts table yet (or none at all). */
const local = new MemoryBoardStore();
let warned = false;

async function attempts<T>(store: BoardStore | null, run: (counter: BoardStore) => Promise<T>): Promise<T> {
  if (!store) return run(local);
  try {
    return await run(store);
  } catch (error) {
    if (!warned) console.warn('[admin] admin_attempts is not usable, counting wrong codes per instance (run supabase/schema.sql again):', (error as Error).message);
    warned = true;
    return run(local);
  }
}

const WRONG = 'That code is not right, or there were too many tries. Wait a while and try again.';

/**
 * Turns admin mode on for this browser when the code is right. The same refusal comes back for a wrong code and for
 * a caller who is locked out, so trying cannot tell the two apart.
 */
export async function signIn(cfg: AdminConfig, store: BoardStore | null, req: IncomingMessage, res: ServerResponse, attempt: unknown): Promise<void> {
  const [address, global] = buckets(req);
  const locked = await Promise.all([attempts(store, (counter) => counter.adminLockedUntil(address!)), attempts(store, (counter) => counter.adminLockedUntil(global!))]);
  const code = typeof attempt === 'string' ? attempt : '';
  if (locked.some(Boolean) || !code || !codeMatches(cfg, code)) {
    if (!locked.some(Boolean)) {
      await Promise.all([attempts(store, (counter) => counter.adminFailure(address!, PER_ADDRESS.max, PER_ADDRESS.windowMs)), attempts(store, (counter) => counter.adminFailure(global!, SITE_WIDE.max, SITE_WIDE.windowMs))]);
      console.warn(`[admin] wrong admin code from ${address}`);
    }
    throw new ApiError(403, WRONG, 'admin_denied');
  }
  const session: AdminSession = { role: 'admin', exp: Date.now() + SESSION_MS, jti: randomUUID() };
  addCookies(res, [cookie(req, seal(cfg.key, session), SESSION_MS / 1000)]);
  await store?.recordAudit({ action: 'sign_in', target: '', ip: address!, snapshot: { jti: session.jti } });
}

export function signOut(req: IncomingMessage, res: ServerResponse): void {
  addCookies(res, [cookie(req, '', 0)]);
}

/** The admin session this request carries, if it is genuine and not expired. */
export function adminSession(cfg: AdminConfig | null, req: IncomingMessage): AdminSession | null {
  if (!cfg) return null;
  const sealed = readCookies(req).get(COOKIE);
  const session = sealed ? unseal<AdminSession>(cfg.key, sealed) : null;
  return session?.role === 'admin' && typeof session.exp === 'number' && session.exp > Date.now() ? session : null;
}

export function requireAdmin(cfg: AdminConfig | null, req: IncomingMessage): AdminSession {
  const session = adminSession(cfg, req);
  if (!session) throw new ApiError(401, 'Admin mode is off. Turn it on in Settings.', 'admin_required');
  return session;
}

/** Strict, so no other site can send it along; scoped to the API, where it is read. */
function cookie(req: IncomingMessage, value: string, maxAgeSeconds: number): string {
  const https = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim() === 'https' || process.env.VERCEL === '1';
  return `${COOKIE}=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${Math.round(maxAgeSeconds)}${https ? '; Secure' : ''}`;
}
