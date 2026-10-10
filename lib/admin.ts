/** Admin privileges follow verified NYU accounts, checked against the deployment allowlist on every request. */
import type { IncomingMessage } from 'node:http';
import type { AppUsageReport, UsageDay } from './app-usage.ts';
import { emailSession } from './auth.ts';
import { STANDING_LABELS, standingFor } from './board.ts';
import { boardStore, type AdminMember, type AdminOverview } from './board-store.ts';
import { ApiError } from './http.ts';
import { modelUsage, noteAlert, saveModelUsage, usageDay, type UsageState } from './model-usage.ts';
import { modelKeys } from './providers.ts';

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

/* ---------- Email to the administrators ---------- */

/** Where admin emails go: the NYU address of every NetID on ROR_ADMIN_NETIDS. */
export function adminEmails(cfg: Set<string> = adminConfig()): string[] {
  return [...cfg].map((netId) => `${netId}@nyu.edu`);
}

/**
 * Emails every administrator through Resend (the login sender). Resend sends one email per `dedupe` key in a day, so
 * several instances raising the same alert send it once. Throws with Resend's reason when it refuses.
 */
export async function emailAdmins(subject: string, text: string, dedupe: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  const to = adminEmails();
  if (!apiKey || !from || !to.length) throw new ApiError(503, 'Admin email needs RESEND_API_KEY, RESEND_FROM and ROR_ADMIN_NETIDS.', 'email_unavailable');
  const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'idempotency-key': dedupe }, body: JSON.stringify({ from, to, subject, text }), signal: AbortSignal.timeout(12_000) });
  // 409: this alert already went out from another instance under the same key.
  if (response.ok || response.status === 409) return;
  const error = (await response.json().catch(() => ({}))) as { message?: string };
  throw new ApiError(503, `Resend refused the email (${response.status}): ${(error.message ?? '').slice(0, 200)}`, 'email_failed');
}

const STATE_WORDS: Record<UsageState, string> = {
  ok: 'working',
  idle: 'not used today',
  refused: 'KEY REFUSED',
  spent: "today's quota used up",
  limited: 'rate limited',
  gone: 'model retired',
  overloaded: 'overloaded',
  failing: 'failing',
};

/** Today's calls per key and model, as plain text for an email. */
export async function usageText(now = Date.now()): Promise<string> {
  const report = await modelUsage(modelKeys(), now);
  return report.keys
    .map((key) => {
      const models = key.models.filter((model) => model.ok || model.failed).map((model) => `    ${model.model}: ${STATE_WORDS[model.state]}, ${model.ok} ok, ${model.failed} failed${model.state !== 'ok' && model.lastError ? ` (${model.lastError})` : ''}`);
      return [`${key.label} (key ending ${key.hint}): ${STATE_WORDS[key.state]}, ${key.ok} ok, ${key.failed} failed today`, ...models].join('\n');
    })
    .join('\n');
}

/** Hours between two outage emails, whichever instance notices. */
const ALERT_HOURS = 3;
let alertedAt = 0;

/**
 * Tells the administrators that every answer model failed a student's question, with what each key did today. At most
 * once every ALERT_HOURS: this instance stops asking for half an hour, and Resend drops a repeat inside the same window.
 */
export async function alertModelsDown(reason: string, now = Date.now()): Promise<void> {
  if (now - alertedAt < 30 * 60_000 || !adminEmails().length) return;
  alertedAt = now;
  try {
    await saveModelUsage(now);
    const usage = await usageText(now).catch(() => '(the usage report could not be read)');
    const abuDhabi = new Date(now + 4 * 3_600_000);
    const time = abuDhabi.toISOString().slice(11, 16);
    const window = `${usageDay(now)}-${Math.floor(abuDhabi.getUTCHours() / ALERT_HOURS)}`;
    const site = process.env.ROR_SITE_URL || 'https://nyuad.life';
    const text = [
      `Every answer model failed a student's question at ${time} (Abu Dhabi).`,
      `The student was told: ${reason}`,
      '',
      'What each key did today:',
      usage,
      '',
      `Live view: ${site}/settings#admin (Model keys).`,
      `You get at most one of these every ${ALERT_HOURS} hours.`,
    ].join('\n');
    await emailAdmins('nyuad.life: answers are down', text, `models-down-${window}`);
    await noteAlert(reason, now);
  } catch (error) {
    console.error('[models] could not send the outage email:', (error as Error).message);
  }
}

/* ---------- The dashboard ---------- */

export interface Dashboard {
  day: string;
  members: { total: number; today: number; week: number; month: number };
  /** Members last seen today, in the last 7 days and the last 30, by Abu Dhabi days. */
  active: { today: number; week: number; month: number };
  /** Every day of the window, oldest first: requests, people and what they did, and sign-ups that day. */
  days: Array<UsageDay & { signups: number }>;
  routes: AppUsageReport['routes'];
  hours: number[];
  shared: boolean;
  newest: Array<AdminMember & { standing: string }>;
  majors: Array<{ name: string; n: number }>;
  standings: Array<{ name: string; n: number }>;
  board: AdminOverview['counts'];
}

/** Usage counts and the member list folded into what the admin page shows. */
export function dashboard(usage: AppUsageReport, overview: AdminOverview, now = Date.now()): Dashboard {
  const day = usageDay(now);
  const since = (days: number) => usageDay(now - (days - 1) * 86_400_000);
  const joined = (member: AdminMember) => usageDay(Date.parse(member.createdAt));
  const seen = (member: AdminMember) => usageDay(Date.parse(member.lastSeenAt));
  const members = overview.members;
  const count = (test: (member: AdminMember) => boolean) => members.filter(test).length;
  const signups = new Map<string, number>();
  for (const member of members) signups.set(joined(member), (signups.get(joined(member)) ?? 0) + 1);
  const tally = (values: string[]) => [...values.reduce((map, value) => map.set(value, (map.get(value) ?? 0) + 1), new Map<string, number>())].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);
  return {
    day,
    members: { total: members.length, today: count((member) => joined(member) === day), week: count((member) => joined(member) >= since(7)), month: count((member) => joined(member) >= since(30)) },
    active: { today: count((member) => seen(member) === day), week: count((member) => seen(member) >= since(7)), month: count((member) => seen(member) >= since(30)) },
    days: usage.days.map((entry) => ({ ...entry, signups: signups.get(entry.day) ?? 0 })),
    routes: usage.routes,
    hours: usage.hours,
    shared: usage.shared,
    newest: members.slice(0, 12).map((member) => ({ ...member, standing: STANDING_LABELS[standingFor(member.classOf, new Date(now))] })),
    majors: tally(members.map((member) => member.major)).slice(0, 10),
    standings: tally(members.map((member) => STANDING_LABELS[standingFor(member.classOf, new Date(now))])),
    board: overview.counts,
  };
}
