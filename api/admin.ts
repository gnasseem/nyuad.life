/**
 * Admin mode (lib/admin.ts): sign in with ROR_ADMIN_CODE, then remove any post, bar its writer from posting, and
 * check which models answer.
 *
 *   GET  /api/admin?op=me                    { available, admin }
 *   GET  /api/admin?op=bans                  the barred NetIDs
 *   GET  /api/admin?op=models                one tiny request to every model, and what each said
 *   POST /api/admin { op: login, code }      turns admin mode on for this browser (an HttpOnly cookie)
 *   POST /api/admin { op: logout }
 *   POST /api/admin { op: remove, type: question|answer|notice|listing|offer, id, ban?, reason? }
 *   POST /api/admin { op: unban, netId }
 */
import { adminConfig, adminSession, requireAdmin, signIn, signOut } from '../lib/admin.ts';
import { validateNetId } from '../lib/board.ts';
import { boardStore, type AdminTarget, type BoardStore } from '../lib/board-store.ts';
import { geminiConfig, geminiKeyProblem } from '../lib/gemini.ts';
import { ApiError, clientIp, clientKey, queryString, rateLimit, readJson, route, sendJson } from '../lib/http.ts';
import { ownerOf } from '../lib/identity.ts';
import { checkModels, providersFromEnv, warmModels } from '../lib/providers.ts';
import { collapseWhitespace } from '../lib/text.ts';

const TARGETS: AdminTarget[] = ['question', 'answer', 'notice', 'listing', 'offer'];

export default route(['GET', 'POST'], async (req, res) => {
  const cfg = adminConfig();
  const body = req.method === 'POST' ? await readJson<Record<string, unknown>>(req) : {};
  const op = String(req.method === 'POST' ? (body.op ?? '') : queryString(req, 'op')).trim();
  const store = boardStore();

  if (op === 'me') {
    sendJson(res, 200, { available: Boolean(cfg), admin: Boolean(adminSession(cfg, req)) });
    return;
  }
  if (op === 'login' && req.method === 'POST') {
    // The database limit (lib/admin.ts) is the real one; this keeps one instance from being hammered meanwhile.
    rateLimit(req, 5, 2, 'admin-login');
    if (!cfg) throw new ApiError(404, 'Admin mode is not set up on this server (ROR_ADMIN_CODE).', 'admin_off');
    await signIn(cfg, store, req, res, body.code);
    sendJson(res, 200, { admin: true });
    return;
  }
  if (op === 'logout' && req.method === 'POST') {
    signOut(req, res);
    sendJson(res, 200, { admin: false });
    return;
  }

  const session = requireAdmin(cfg, req);
  rateLimit(req, 60, 60, 'admin');
  const ip = `ip:${clientKey(clientIp(req))}`;
  switch (op) {
    case 'models': {
      rateLimit(req, 3, 1, 'admin-models');
      await warmModels(4_000);
      const gemini = geminiConfig();
      const results = await checkModels(gemini, providersFromEnv());
      sendJson(res, 200, { geminiKeyProblem: geminiKeyProblem(gemini), results });
      return;
    }
    case 'bans': {
      sendJson(res, 200, { bans: await need(store).listBans() });
      return;
    }
    case 'remove': {
      if (req.method !== 'POST') break;
      const board = need(store);
      const type = String(body.type ?? '') as AdminTarget;
      if (!TARGETS.includes(type)) throw new ApiError(400, 'Unknown kind of post.', 'bad_type');
      const removed = await board.adminDelete(type, String(body.id ?? ''));
      if (!removed) throw new ApiError(404, 'That post is already gone.', 'not_found');
      const reason = collapseWhitespace(String(body.reason ?? '')).slice(0, 200);
      const banned = body.ban === true ? await posterOf(board, type, removed) : null;
      if (banned) await board.setBan(banned, true, reason);
      await board.recordAudit({ action: `remove_${type}${banned ? '_and_ban' : ''}`, target: String(body.id), snapshot: { removed, reason, by: session.jti }, ip });
      sendJson(res, 200, { ok: true, banned });
      return;
    }
    case 'unban': {
      if (req.method !== 'POST') break;
      const board = need(store);
      const netId = validateNetId(body.netId);
      await board.setBan(netId, false);
      await board.recordAudit({ action: 'unban', target: netId, ip, snapshot: { by: session.jti } });
      sendJson(res, 200, { ok: true });
      return;
    }
  }
  throw new ApiError(400, 'Unknown admin operation.', 'bad_op');
});

function need(store: BoardStore | null): BoardStore {
  if (!store) throw new ApiError(503, 'The board is not set up on this server.', 'board_unavailable');
  return store;
}

/** The NetID behind a removed post: its poster, its helper, or for a question the profile its asker's browser set up. */
async function posterOf(store: BoardStore, type: AdminTarget, row: Record<string, unknown>): Promise<string | null> {
  const direct = row.poster_net_id ?? row.posterNetId ?? row.helper_net_id ?? row.helperNetId;
  if (typeof direct === 'string' && direct) return direct;
  const askerKey = row.asker_key ?? row.askerKey;
  if (type !== 'question' || typeof askerKey !== 'string') return null;
  try {
    return (await store.findProfileByOwner(ownerOf(askerKey)))?.netId ?? null;
  } catch {
    return null;
  }
}
