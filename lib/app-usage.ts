/**
 * How the site is used, for the admins' dashboard: requests per route and day (with failures and time taken), requests
 * by hour, the distinct members and devices seen, and counts of what students did (questions asked, answers written,
 * reviews, logins, sign-ups). Kept like the model usage (lib/model-usage.ts): each instance counts in memory and saves
 * its own row per day in guide_summaries (`app:usage:<day>:<instance>`), so no schema change is needed and instances
 * never overwrite each other. Members and devices are kept as short keyed hashes: enough to count them, not to list them.
 */
import { createHmac, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { usageDay } from './model-usage.ts';
import { supabaseConfig, type SupabaseConfig } from './supabase.ts';

/** What students did, counted per day. */
export type AppEvent = 'ask' | 'ask_cached' | 'ask_failed' | 'login' | 'signup' | 'question' | 'answer' | 'review' | 'listing' | 'offer' | 'event' | 'plan' | 'rating';

interface RouteCount {
  n: number;
  /** Responses with a 5xx status. */
  err: number;
  /** Total milliseconds spent, for the average. */
  ms: number;
}

interface DayCounts {
  requests: number;
  errors: number;
  /** 4xx other than 429: refused input, missing sign-in. */
  rejected: number;
  limited: number;
  ms: number;
  routes: Record<string, RouteCount>;
  /** Requests in each hour of the day in Abu Dhabi. */
  hours: number[];
  people: Set<string>;
  devices: Set<string>;
  events: Partial<Record<AppEvent, number>>;
}

interface SavedDay extends Omit<DayCounts, 'people' | 'devices'> {
  people: string[];
  devices: string[];
}

/** One day across every instance, for the dashboard. */
export interface UsageDay {
  day: string;
  requests: number;
  errors: number;
  rejected: number;
  limited: number;
  avgMs: number;
  people: number;
  devices: number;
  events: Partial<Record<AppEvent, number>>;
}

export interface AppUsageReport {
  /** Oldest first, one entry per day of the window, zeros for days nobody came. */
  days: UsageDay[];
  /** Today's requests per route, busiest first, and per hour. */
  routes: Array<{ name: string; n: number; err: number; avgMs: number }>;
  hours: number[];
  /** False when the database could not be read: the counts are this instance's alone. */
  shared: boolean;
}

const PREFIX = 'app:usage:';
const KEEP_DAYS = 60;
const SAVE_EVERY_MS = 15_000;
const INSTANCE = randomUUID().slice(0, 8);

const memory = new Map<string, DayCounts>();
const unsaved = new Set<string>();
let savedAt = 0;
let lastSweep = 0;

function emptyDay(): DayCounts {
  return { requests: 0, errors: 0, rejected: 0, limited: 0, ms: 0, routes: {}, hours: Array(24).fill(0), people: new Set(), devices: new Set(), events: {} };
}

function today(now: number): DayCounts {
  const day = usageDay(now);
  let counts = memory.get(day);
  if (!counts) {
    counts = emptyDay();
    memory.set(day, counts);
  }
  unsaved.add(day);
  return counts;
}

/** A short keyed hash: the same person or device always gives the same value, and the value does not give them away. */
export function usageHash(value: string): string {
  return createHmac('sha256', process.env.SESSION_SECRET || 'nyuad.life usage').update(value).digest('hex').slice(0, 12);
}

/** "/api/board?op=feed" -> "board:feed"; a POST names its operation in the body. */
export function routeName(req: IncomingMessage & { body?: unknown }): string {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '') || 'root';
  const fromBody = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>).op : undefined;
  const op = url.searchParams.get('op') || (typeof fromBody === 'string' ? fromBody : '') || (url.searchParams.has('rating') ? 'rating' : url.searchParams.has('profs') ? 'profs' : '');
  return op ? `${path}:${op.slice(0, 24)}` : path;
}

/** Counts one API request once its response is out. `person` is a verified NetID, `device` the client's address. */
export function recordRequest(entry: { route: string; status: number; ms: number; person?: string; device?: string }, now = Date.now()): void {
  if (process.env.VITEST) return;
  const counts = today(now);
  counts.requests++;
  counts.ms += entry.ms;
  if (entry.status >= 500) counts.errors++;
  else if (entry.status === 429) counts.limited++;
  else if (entry.status >= 400) counts.rejected++;
  const route = (counts.routes[entry.route] ??= { n: 0, err: 0, ms: 0 });
  route.n++;
  route.ms += entry.ms;
  if (entry.status >= 500) route.err++;
  counts.hours[new Date(now + 4 * 3_600_000).getUTCHours()]!++;
  if (entry.person) counts.people.add(usageHash(`person:${entry.person}`));
  if (entry.device) counts.devices.add(usageHash(`device:${entry.device}`));
}

/** Counts something a student did: a question asked, an answer written, a sign-up. */
export function recordEvent(event: AppEvent, now = Date.now()): void {
  if (process.env.VITEST) return;
  const counts = today(now);
  counts.events[event] = (counts.events[event] ?? 0) + 1;
}

/* ---------- Saving and reading ---------- */

async function rest(cfg: SupabaseConfig, path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${cfg.url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: cfg.serviceKey, authorization: `Bearer ${cfg.serviceKey}`, 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`${response.status} ${(await response.text().catch(() => '')).slice(0, 200)}`);
  return response;
}

function toSaved(counts: DayCounts): SavedDay {
  return { ...counts, people: [...counts.people], devices: [...counts.devices] };
}

/**
 * Saves this instance's counts, at most every few seconds unless `force`: a request is counted in memory at once, and a
 * burst of them is written in one go. Without a database the counts stay in this instance.
 */
export async function saveAppUsage(force = false, now = Date.now()): Promise<void> {
  const cfg = supabaseConfig();
  if (!unsaved.size || !cfg || process.env.VITEST || (!force && now - savedAt < SAVE_EVERY_MS)) return;
  savedAt = now;
  const days = [...unsaved];
  unsaved.clear();
  try {
    const rows = days.map((day) => ({ key: `${PREFIX}${day}:${INSTANCE}`, payload: toSaved(memory.get(day) ?? emptyDay()), created_at: new Date(now).toISOString() }));
    await rest(cfg, 'guide_summaries?on_conflict=key', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) });
  } catch (error) {
    for (const day of days) unsaved.add(day);
    console.warn('[usage] could not save app usage:', (error as Error).message);
    return;
  }
  for (const day of memory.keys()) if (day < usageDay(now) && !unsaved.has(day)) memory.delete(day);
  if (now - lastSweep > 6 * 3_600_000) {
    lastSweep = now;
    await rest(cfg, `guide_summaries?key=like.${encodeURIComponent(`${PREFIX}*`)}&created_at=lt.${encodeURIComponent(new Date(now - KEEP_DAYS * 86_400_000).toISOString())}`, { method: 'DELETE', headers: { prefer: 'return=minimal' } }).catch(() => undefined);
  }
}

/** Every instance's counts per day for the last `window` days, merged, with today's routes and hours. */
export async function appUsage(window = 30, now = Date.now()): Promise<AppUsageReport> {
  await saveAppUsage(true, now);
  const byDay = new Map<string, SavedDay[]>();
  const add = (day: string, saved: SavedDay) => byDay.set(day, [...(byDay.get(day) ?? []), saved]);
  let shared = false;
  const cfg = process.env.VITEST ? null : supabaseConfig();
  if (cfg) {
    try {
      const since = new Date(now - (window + 1) * 86_400_000).toISOString();
      const response = await rest(cfg, `guide_summaries?select=key,payload&key=like.${encodeURIComponent(`${PREFIX}*`)}&created_at=gte.${encodeURIComponent(since)}&limit=10000`);
      for (const row of (await response.json()) as Array<{ key: string; payload: SavedDay | null }>) {
        const [day, instance] = row.key.slice(PREFIX.length).split(':');
        if (day && row.payload && !(instance === INSTANCE && memory.has(day))) add(day, row.payload);
      }
      shared = true;
    } catch (error) {
      console.warn('[usage] could not read app usage:', (error as Error).message);
    }
  }
  for (const [day, counts] of memory) add(day, toSaved(counts));

  const days: UsageDay[] = [];
  for (let i = window - 1; i >= 0; i--) {
    const day = usageDay(now - i * 86_400_000);
    const parts = byDay.get(day) ?? [];
    const sum = (field: 'requests' | 'errors' | 'rejected' | 'limited' | 'ms') => parts.reduce((total, part) => total + (part[field] ?? 0), 0);
    const events: Partial<Record<AppEvent, number>> = {};
    for (const part of parts) for (const [name, n] of Object.entries(part.events ?? {})) events[name as AppEvent] = (events[name as AppEvent] ?? 0) + (n ?? 0);
    const requests = sum('requests');
    days.push({
      day,
      requests,
      errors: sum('errors'),
      rejected: sum('rejected'),
      limited: sum('limited'),
      avgMs: requests ? Math.round(sum('ms') / requests) : 0,
      people: new Set(parts.flatMap((part) => part.people ?? [])).size,
      devices: new Set(parts.flatMap((part) => part.devices ?? [])).size,
      events,
    });
  }
  const todays = byDay.get(usageDay(now)) ?? [];
  const routes = new Map<string, RouteCount>();
  const hours: number[] = Array(24).fill(0);
  for (const part of todays) {
    for (const [name, count] of Object.entries(part.routes ?? {})) {
      const into = routes.get(name) ?? { n: 0, err: 0, ms: 0 };
      into.n += count.n;
      into.err += count.err;
      into.ms += count.ms;
      routes.set(name, into);
    }
    (part.hours ?? []).forEach((n, hour) => (hours[hour]! += n));
  }
  return {
    days,
    routes: [...routes].map(([name, count]) => ({ name, n: count.n, err: count.err, avgMs: count.n ? Math.round(count.ms / count.n) : 0 })).sort((a, b) => b.n - a.n),
    hours,
    shared,
  };
}

/** Test hook. */
export function resetAppUsage(): void {
  memory.clear();
  unsaved.clear();
  savedAt = 0;
}
