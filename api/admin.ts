/**
 * The admin page, for verified accounts on ROR_ADMIN_NETIDS: how the site is used (op=stats), what the answer models
 * are doing (models, usage), moderation (bans, audit, remove, unban) and the outage email test. Also one slice of the
 * course and professor review job (op=reviews), for administrators and for scripts/reviews.ts --remote.
 */
import { timingSafeEqual } from 'node:crypto';
import { adminConfig, adminEmails, adminSession, dashboard, dataOverview, emailAdmins, requireAdmin, usageText } from '../lib/admin.ts';
import { appUsage } from '../lib/app-usage.ts';
import { validateNetId } from '../lib/board.ts';
import { boardStore, type AdminTarget, type BoardStore } from '../lib/board-store.ts';
import { loadCatalog } from '../lib/courses.ts';
import { geminiConfig, geminiKeyProblem } from '../lib/gemini.ts';
import { ApiError, clientIp, clientKey, queryString, rateLimit, readJson, route, sendJson, type ApiRequest } from '../lib/http.ts';
import { ownerOf } from '../lib/identity.ts';
import { lastAlert, modelUsage, saveModelUsage } from '../lib/model-usage.ts';
import { checkModels, modelKeys, providersFromEnv, warmModels } from '../lib/providers.ts';
import { reviewsJobToken, runReviews } from '../lib/reviews.ts';
import { loadArchive } from '../lib/store.ts';
import { supabaseConfig } from '../lib/supabase.ts';
import { collapseWhitespace } from '../lib/text.ts';

const TARGETS: AdminTarget[] = ['question', 'answer', 'notice', 'listing', 'offer', 'review'];

export default route(['GET', 'POST'], async (req, res) => {
  const cfg = adminConfig();
  const body = req.method === 'POST' ? await readJson<Record<string, unknown>>(req) : {};
  const op = String(req.method === 'POST' ? (body.op ?? '') : queryString(req, 'op')).trim();
  const store = boardStore();

  if (op === 'me') {
    sendJson(res, 200, { available: cfg.size > 0, admin: Boolean(await adminSession(cfg, req)) });
    return;
  }
  if (op === 'reviews' && req.method === 'POST') {
    if (!jobToken(req)) await requireAdmin(cfg, req);
    const board = need(store);
    if (!board.persistent) throw new ApiError(503, 'Reviews are kept in Supabase, which this server does not have.', 'board_unavailable');
    const started = Date.now();
    // About three and a half minutes of reading, and nothing still running after four and a half (the limit is five).
    const result = await runReviews({ store: board, archive: await loadArchive(), catalog: loadCatalog(), deadline: started + 210_000, end: started + 270_000, workers: Math.min(4, Math.max(1, Number(body.workers) || 3)), limit: Number(body.limit) || undefined, log: (message) => console.log(`[reviews] ${message}`) });
    sendJson(res, 200, result);
    return;
  }
  const session = await requireAdmin(cfg, req);
  rateLimit(req, 60, 60, 'admin');
  const ip = `ip:${clientKey(clientIp(req))}`;
  switch (op) {
    case 'stats': {
      const now = Date.now();
      const [usage, overview] = await Promise.all([appUsage(30, now), need(store).adminOverview(new Date(now))]);
      sendJson(res, 200, dashboard(usage, overview, now));
      return;
    }
    case 'data': {
      sendJson(res, 200, await dataOverview());
      return;
    }
    case 'audit': {
      sendJson(res, 200, { audit: await need(store).listAudit(40) });
      return;
    }
    case 'ask-reports': {
      const entries = await need(store).listSummaryFields('ask-report:', ['question', 'answer', 'reason', 'sources', 'resolvedAt', 'reportedAt']);
      sendJson(res, 200, { reports: entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((entry) => ({ id: entry.key, ...entry.fields, createdAt: entry.fields.reportedAt || entry.createdAt })) });
      return;
    }
    case 'resolve-report': {
      if (req.method !== 'POST') break;
      const id = String(body.id ?? '');
      if (!/^ask-report:[a-zA-Z0-9-]+$/.test(id) || typeof body.resolved !== 'boolean') throw new ApiError(400, 'Choose an Ask report and its status.', 'bad_report');
      const board = need(store);
      const entry = await board.getSummary(id);
      if (!entry) throw new ApiError(404, 'This report no longer exists.', 'not_found');
      const payload = entry.payload as Record<string, unknown>;
      await board.putSummary(id, { ...payload, reportedAt: payload.reportedAt || entry.createdAt, resolvedAt: body.resolved ? new Date().toISOString() : null });
      await board.recordAudit({ action: body.resolved ? 'resolve_report' : 'reopen_report', target: id, snapshot: { by: session.jti }, ip });
      sendJson(res, 200, { ok: true });
      return;
    }
    case 'models': {
      rateLimit(req, 3, 1, 'admin-models');
      await warmModels(4_000);
      const gemini = geminiConfig();
      const results = await checkModels(gemini, providersFromEnv());
      sendJson(res, 200, { geminiKeyProblem: geminiKeyProblem(gemini), results });
      return;
    }
    case 'usage': {
      // What every key did today across instances, this instance's latest calls included.
      await saveModelUsage();
      const [usage, alert] = await Promise.all([modelUsage(modelKeys()), lastAlert().catch(() => null)]);
      sendJson(res, 200, { ...usage, alerts: { to: adminEmails(cfg), last: alert } });
      return;
    }
    case 'alert-test': {
      if (req.method !== 'POST') break;
      rateLimit(req, 3, 3 / 60, 'admin-alert-test');
      const usage = await usageText();
      await emailAdmins('nyuad.life: test of the outage email', `This is a test. When every answer model fails a question, an email like this one is sent, with what each key did today:\n\n${usage}`, `models-test-${Date.now()}`);
      sendJson(res, 200, { ok: true, to: adminEmails(cfg) });
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

/** Whether the request carries the review job's token, which only someone holding the Supabase service key can make. */
function jobToken(req: ApiRequest): boolean {
  const key = supabaseConfig()?.serviceKey;
  const given = /^Bearer ([a-f0-9]{64})$/.exec(String(req.headers.authorization ?? ''))?.[1];
  return Boolean(key && given && timingSafeEqual(Buffer.from(given), Buffer.from(reviewsJobToken(key))));
}

function need(store: BoardStore | null): BoardStore {
  if (!store) throw new ApiError(503, 'The board is not set up on this server.', 'board_unavailable');
  return store;
}

/** The NetID behind a removed post: its poster, its helper, or for a question the profile its asker's browser set up. */
async function posterOf(store: BoardStore, type: AdminTarget, row: Record<string, unknown>): Promise<string | null> {
  const direct = row.poster_net_id ?? row.posterNetId ?? row.helper_net_id ?? row.helperNetId ?? row.net_id ?? row.netId;
  if (typeof direct === 'string' && direct) return direct;
  const askerKey = row.asker_key ?? row.askerKey;
  if (type !== 'question' || typeof askerKey !== 'string') return null;
  try {
    return (await store.findProfileByOwner(ownerOf(askerKey)))?.netId ?? null;
  } catch {
    return null;
  }
}
