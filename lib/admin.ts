/** Admin privileges follow verified NYU accounts, checked against the deployment allowlist on every request. */
import type { IncomingMessage } from 'node:http';
import { emailSession } from './auth.ts';
import { boardStore } from './board-store.ts';
import { ApiError } from './http.ts';

export function adminConfig(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set((env.ROR_ADMIN_NETIDS ?? '').split(/[\s,;]+/).map((value) => value.trim().toLowerCase().replace(/@nyu\.edu$/, '')).filter((value) => /^[a-z]{1,8}\d{1,6}$/.test(value)));
}
export async function adminSession(cfg: Set<string>, req: IncomingMessage): Promise<{ jti: string } | null> {
  const session = emailSession(req);
  if (!session || !cfg.has(session.netId)) return null;
  const store = boardStore();
  if (!store || await store.isBanned(session.netId) || !await store.getProfile(session.netId)) return null;
  return { jti: session.netId };
}
export async function requireAdmin(cfg: Set<string>, req: IncomingMessage): Promise<{ jti: string }> {
  const session = await adminSession(cfg, req);
  if (!session) throw new ApiError(403, 'Your verified account is not an administrator.', 'admin_required');
  return session;
}
