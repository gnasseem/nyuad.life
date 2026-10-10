/**
 * What each model key did: calls that worked and calls that failed, per key and model and day, the last error, and
 * what the provider says is left of its quota. Every Gemini and backup-provider call is counted here (lib/gemini.ts,
 * lib/providers.ts). Each instance keeps its counts in memory and saves them once a response is out (lib/http.ts), as
 * its own row per day in guide_summaries, so instances never overwrite each other. Admins read the merged report in
 * Settings (api/admin.ts); the outage email quotes it (lib/admin.ts).
 */
import { randomUUID } from 'node:crypto';
import { supabaseConfig, type SupabaseConfig } from './supabase.ts';

export interface ModelCall {
  /** The key: "gemini" or "groq" for a provider's first key, "groq-2" for its second. */
  key: string;
  provider: string;
  /** The key's last four characters, to tell keys apart when one is replaced or they are reordered. */
  hint: string;
  model: string;
  ok: boolean;
  status?: number;
  error?: string;
  /** Requests left today and the day's limit, when the provider says (Groq's headers, a Gemini daily-quota error). */
  remaining?: number;
  limit?: number;
}

export interface UsageRow {
  key: string;
  provider: string;
  hint: string;
  model: string;
  ok: number;
  failed: number;
  lastOkAt: string | null;
  lastErrorAt: string | null;
  lastStatus: number | null;
  lastError: string | null;
  remaining: number | null;
  limit: number | null;
  limitAt: string | null;
}

/** working | not used today | key refused | day's quota spent | rate limited | model retired | overloaded | failing */
export type UsageState = 'ok' | 'idle' | 'refused' | 'spent' | 'limited' | 'gone' | 'overloaded' | 'failing';

/** A key the server has, with the models it is asked for: from providers.ts' modelKeys(). */
export interface ModelKey {
  key: string;
  provider: string;
  label: string;
  hint: string;
  models: string[];
  /** The provider's free tier in a few words. */
  freeTier: string;
}

export interface KeyReport extends Omit<ModelKey, 'models'> {
  state: UsageState;
  ok: number;
  failed: number;
  week: { ok: number; failed: number };
  models: Array<UsageRow & { state: UsageState }>;
}

export interface UsageReport {
  day: string;
  keys: KeyReport[];
  /** False when the counts could not be read across instances (no database, or it failed): they are this instance's alone. */
  shared: boolean;
}

const PREFIX = 'models:usage:';
const ALERT_KEY = 'models:alert';
const KEEP_DAYS = 8;
const INSTANCE = randomUUID().slice(0, 8);

/** Day -> `key|hint|model` -> counts, for this instance. */
const memory = new Map<string, Map<string, UsageRow>>();
/** Days counted since the last save. */
const unsaved = new Set<string>();
let lastSweep = 0;

/** The day in Abu Dhabi (UTC+4 all year), where the site's students are. */
export function usageDay(now = Date.now()): string {
  return new Date(now + 4 * 3_600_000).toISOString().slice(0, 10);
}

function emptyRow(call: Pick<UsageRow, 'key' | 'provider' | 'hint' | 'model'>): UsageRow {
  return { key: call.key, provider: call.provider, hint: call.hint, model: call.model, ok: 0, failed: 0, lastOkAt: null, lastErrorAt: null, lastStatus: null, lastError: null, remaining: null, limit: null, limitAt: null };
}

/**
 * Error texts sometimes echo part of a key: a long unbroken run with digits in it is cut out before it is kept or
 * emailed. Gemini's quota names ("GenerateRequestsPerDayPerProjectPerModel-FreeTier") have none, and are kept.
 */
function scrub(text: string): string {
  return text.replace(/[A-Za-z0-9_-]{32,}/g, (run) => (/\d/.test(run) ? '…' : run)).replace(/\s+/g, ' ').trim().slice(0, 300);
}

export function recordModelCall(call: ModelCall, now = Date.now()): void {
  const day = usageDay(now);
  const rows = memory.get(day) ?? new Map<string, UsageRow>();
  memory.set(day, rows);
  const id = `${call.key}|${call.hint}|${call.model}`;
  const row = rows.get(id) ?? emptyRow(call);
  rows.set(id, row);
  const at = new Date(now).toISOString();
  if (call.ok) {
    row.ok++;
    row.lastOkAt = at;
  } else {
    row.failed++;
    row.lastErrorAt = at;
    row.lastStatus = call.status ?? null;
    row.lastError = scrub(call.error ?? '');
  }
  if (call.remaining !== undefined || call.limit !== undefined) {
    row.remaining = call.remaining ?? row.remaining;
    row.limit = call.limit ?? row.limit;
    row.limitAt = at;
  }
  unsaved.add(day);
}

/** How a key or model stands, from its counts and last error: the last thing that happened to it decides. */
export function usageState(row: Pick<UsageRow, 'ok' | 'failed' | 'lastOkAt' | 'lastErrorAt' | 'lastStatus' | 'lastError'>): UsageState {
  if (!row.ok && !row.failed) return 'idle';
  if (!row.lastErrorAt || (row.lastOkAt && row.lastOkAt >= row.lastErrorAt)) return 'ok';
  const status = row.lastStatus ?? 0;
  const error = row.lastError ?? '';
  if (status === 401 || status === 403 || (status === 400 && /api.?key/i.test(error))) return 'refused';
  if (status === 429) return /per[ -]?day|daily|\bRPD\b|\bTPD\b|\blimit: ?0\b/i.test(error) ? 'spent' : 'limited';
  if (status === 404) return 'gone';
  if (status >= 500) return 'overloaded';
  return 'failing';
}

/** One row per key and model: counts added up, and the latest error and quota reading kept. */
export function mergeRows(rows: UsageRow[]): UsageRow[] {
  const merged = new Map<string, UsageRow>();
  for (const row of rows) {
    const id = `${row.key}|${row.hint}|${row.model}`;
    const into = merged.get(id);
    if (!into) {
      merged.set(id, { ...row });
      continue;
    }
    into.ok += row.ok;
    into.failed += row.failed;
    if ((row.lastOkAt ?? '') > (into.lastOkAt ?? '')) into.lastOkAt = row.lastOkAt;
    if ((row.lastErrorAt ?? '') > (into.lastErrorAt ?? '')) Object.assign(into, { lastErrorAt: row.lastErrorAt, lastStatus: row.lastStatus, lastError: row.lastError });
    if ((row.limitAt ?? '') > (into.limitAt ?? '')) Object.assign(into, { remaining: row.remaining, limit: row.limit, limitAt: row.limitAt });
  }
  return [...merged.values()];
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

async function put(cfg: SupabaseConfig, key: string, payload: unknown): Promise<void> {
  await rest(cfg, 'guide_summaries?on_conflict=key', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ key, payload, created_at: new Date().toISOString() }) });
}

/** Saves this instance's counts for the days that changed. Without a database they stay in this instance only. */
export async function saveModelUsage(now = Date.now()): Promise<void> {
  const cfg = supabaseConfig();
  if (!unsaved.size || !cfg || process.env.VITEST) return;
  const days = [...unsaved];
  unsaved.clear();
  try {
    await Promise.all(days.map((day) => put(cfg, `${PREFIX}${day}:${INSTANCE}`, { rows: [...(memory.get(day)?.values() ?? [])] })));
  } catch (error) {
    for (const day of days) unsaved.add(day);
    console.warn('[models] could not save model usage:', (error as Error).message);
    return;
  }
  // Earlier days are in the database now; this instance only keeps counting today.
  for (const day of memory.keys()) if (day < usageDay(now) && !unsaved.has(day)) memory.delete(day);
  if (now - lastSweep > 6 * 3_600_000) {
    lastSweep = now;
    await rest(cfg, `guide_summaries?key=like.${encodeURIComponent(`${PREFIX}*`)}&created_at=lt.${encodeURIComponent(new Date(now - KEEP_DAYS * 86_400_000).toISOString())}`, { method: 'DELETE', headers: { prefer: 'return=minimal' } }).catch(() => undefined);
  }
}

/** Every instance's rows for the last week, by day; this instance's own come from memory, so they are current. */
async function rowsByDay(now: number): Promise<{ days: Map<string, UsageRow[]>; shared: boolean }> {
  const days = new Map<string, UsageRow[]>();
  const add = (day: string, rows: UsageRow[]) => days.set(day, [...(days.get(day) ?? []), ...rows]);
  let shared = false;
  const cfg = process.env.VITEST ? null : supabaseConfig();
  if (cfg) {
    const since = new Date(now - KEEP_DAYS * 86_400_000).toISOString();
    try {
      const response = await rest(cfg, `guide_summaries?select=key,payload&key=like.${encodeURIComponent(`${PREFIX}*`)}&created_at=gte.${encodeURIComponent(since)}&limit=5000`);
      for (const saved of (await response.json()) as Array<{ key: string; payload: { rows?: UsageRow[] } | null }>) {
        const [day, instance] = saved.key.slice(PREFIX.length).split(':');
        if (day && !(instance === INSTANCE && memory.has(day))) add(day, saved.payload?.rows ?? []);
      }
      shared = true;
    } catch (error) {
      console.warn('[models] could not read model usage:', (error as Error).message);
    }
  }
  for (const [day, rows] of memory) add(day, [...rows.values()]);
  return { days, shared };
}

/** Today's counts per key and model across every instance, so one instance can rest what another found spent. */
export async function todaysUsage(now = Date.now()): Promise<UsageRow[]> {
  const { days } = await rowsByDay(now);
  return mergeRows(days.get(usageDay(now)) ?? []);
}

/** Today's counts per key and model, with each one's state, and the week's totals per key. */
export async function modelUsage(keys: ModelKey[], now = Date.now()): Promise<UsageReport> {
  const day = usageDay(now);
  const weekStart = usageDay(now - 6 * 86_400_000);
  const { days, shared } = await rowsByDay(now);
  const today = mergeRows(days.get(day) ?? []);
  const week = mergeRows([...days].filter(([date]) => date >= weekStart).flatMap(([, rows]) => rows));
  const report = keys.map((info): KeyReport => {
    const mine = (row: UsageRow) => row.key === info.key && row.hint === info.hint;
    const used = today.filter(mine);
    const models = [...new Set([...info.models, ...used.map((row) => row.model)])].map((model) => {
      const row = used.find((entry) => entry.model === model) ?? emptyRow({ ...info, model });
      return { ...row, state: usageState(row) };
    });
    const states = models.map((model) => model.state);
    const state: UsageState = states.includes('refused') ? 'refused' : states.includes('ok') ? 'ok' : (states.find((entry) => entry !== 'idle') ?? 'idle');
    const sum = (rows: UsageRow[], field: 'ok' | 'failed') => rows.reduce((total, row) => total + row[field], 0);
    const weekRows = week.filter(mine);
    return { ...info, state, ok: sum(used, 'ok'), failed: sum(used, 'failed'), week: { ok: sum(weekRows, 'ok'), failed: sum(weekRows, 'failed') }, models };
  });
  return { day, keys: report, shared };
}

/** When the last outage email went out, across instances. */
export async function lastAlert(): Promise<{ at: string; reason: string } | null> {
  const cfg = process.env.VITEST ? null : supabaseConfig();
  if (!cfg) return null;
  const response = await rest(cfg, `guide_summaries?select=payload&key=eq.${encodeURIComponent(ALERT_KEY)}&limit=1`);
  const rows = (await response.json()) as Array<{ payload: { at: string; reason: string } }>;
  return rows[0]?.payload ?? null;
}

export async function noteAlert(reason: string, now = Date.now()): Promise<void> {
  const cfg = process.env.VITEST ? null : supabaseConfig();
  if (cfg) await put(cfg, ALERT_KEY, { at: new Date(now).toISOString(), reason }).catch(() => undefined);
}

/** Test hook. */
export function resetModelUsage(): void {
  memory.clear();
  unsaved.clear();
}
