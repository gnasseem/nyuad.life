/** Small helpers shared by every API route so handlers stay readable and behave the same on Vercel and the dev server. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { saveModelUsage } from './model-usage.ts';

export type ApiRequest = IncomingMessage & {
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
};
type ApiResponse = ServerResponse;
export type Handler = (req: ApiRequest, res: ApiResponse) => Promise<void> | void;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'error',
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * The site and its API share an origin, so browsers need no CORS at all; only local development, where the web app
 * may run on another port, gets it. Before this the API answered every origin, so any page on the web could have
 * its visitors' browsers spend the site's model quota.
 */
function cors(req: IncomingMessage, res: ApiResponse): void {
  const origin = header(req, 'origin');
  if (!origin || !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) || process.env.VERCEL === '1') return;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('vary', 'origin');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, x-ror-netid, x-ror-key');
  res.setHeader('access-control-allow-credentials', 'true');
  res.setHeader('access-control-max-age', '86400');
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

/**
 * Whether a request that changes something comes from another site's page: its Origin names another host, or the
 * browser says it is cross-site. Requests with neither (curl, the dev server's tests) are judged by the rest.
 */
export function crossSite(req: IncomingMessage): boolean {
  if (header(req, 'sec-fetch-site') === 'cross-site') return true;
  const origin = header(req, 'origin');
  if (!origin || origin === 'null') return origin === 'null';
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return true;
  }
  const own = [header(req, 'x-forwarded-host'), header(req, 'host')].filter(Boolean);
  const site = (process.env.ROR_SITE_URL ?? '').trim();
  if (site) {
    try {
      own.push(new URL(site).host);
    } catch {
      // not a URL; ignore it
    }
  }
  if (own.includes(host)) return false;
  return !(process.env.VERCEL !== '1' && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host));
}

/**
 * `scope` 'private' keeps a response out of the CDN, which keys its cache by URL alone: anything only members may read
 * must be private, or the next visitor without an account would be served the member's copy.
 */
export function sendJson(res: ApiResponse, status: number, body: unknown, cacheSeconds = 0, scope: 'public' | 'private' = 'public'): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', cacheSeconds <= 0 ? 'no-store' : scope === 'private' ? `private, max-age=${cacheSeconds}` : `public, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 4}`);
  res.end(JSON.stringify(body));
}

export function queryString(req: ApiRequest, name: string): string {
  const fromVercel = req.query?.[name];
  if (typeof fromVercel === 'string') return fromVercel;
  if (Array.isArray(fromVercel)) return fromVercel[0] ?? '';
  const url = new URL(req.url ?? '/', 'http://localhost');
  return url.searchParams.get(name) ?? '';
}

export function queryInt(req: ApiRequest, name: string, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(queryString(req, name), 10);
  if (Number.isNaN(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Reads a JSON body whether the platform parsed it already (Vercel) or not (dev server). */
export async function readJson<T>(req: ApiRequest): Promise<T> {
  if (req.body !== undefined && req.body !== null && typeof req.body !== 'string') return req.body as T;
  const raw = typeof req.body === 'string' ? req.body : await readText(req);
  if (!raw.trim()) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new ApiError(400, 'Body must be valid JSON.', 'bad_json');
  }
}

async function readText(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/** The client's address: Vercel's x-real-ip, else the first x-forwarded-for entry (Vercel overwrites both). */
export function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return header(req, 'x-real-ip') || (first ?? '').split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
}

/**
 * In-memory token bucket per client IP and scope, so browsing never eats into the ask budget; resets whenever the
 * function instance recycles, which is fine for abuse control.
 */
const buckets = new Map<string, { tokens: number; updated: number }>();
export function rateLimit(req: IncomingMessage, capacity: number, perMinute: number, scope = 'default', who?: string): void {
  // `who` counts a person (a NetID) rather than an address, which a whole campus behind one NAT can share.
  const ip = `${scope}:${who ?? clientKey(clientIp(req))}`;
  const now = Date.now();
  const bucket = buckets.get(ip) ?? { tokens: capacity, updated: now };
  bucket.tokens = Math.min(capacity, bucket.tokens + ((now - bucket.updated) / 60_000) * perMinute);
  bucket.updated = now;
  if (bucket.tokens < 1) {
    buckets.set(ip, bucket);
    throw new ApiError(429, 'Too many requests, try again in a minute.', 'rate_limited');
  }
  bucket.tokens -= 1;
  buckets.set(ip, bucket);
  if (buckets.size > 5000) {
    for (const [key, value] of buckets) if (now - value.updated > 600_000) buckets.delete(key);
  }
}

/**
 * Who a rate limit counts: an IPv4 address, or an IPv6 /64, since one connection is handed a whole /64 and could
 * otherwise rotate addresses to reset its limits.
 */
export function clientKey(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1]!;
  if (!ip.includes(':')) return ip;
  const [head = '', tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/** Failures of the board's database (lib/board-store.ts storageError), whose messages are for the owner. */
const STORAGE_CODES = new Set(['board_schema_missing', 'board_schema_outdated', 'board_key_rejected', 'board_url_wrong', 'board_unreachable', 'board_storage']);

/** Wraps a handler with CORS, OPTIONS, method and origin checks, and uniform error JSON. */
export function route(methods: Array<'GET' | 'POST'>, handler: Handler): Handler {
  return async (req, res) => {
    cors(req, res);
    res.setHeader('x-content-type-options', 'nosniff');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (!methods.includes((req.method ?? 'GET') as 'GET' | 'POST')) {
      sendJson(res, 405, { error: 'method_not_allowed', message: `Use ${methods.join(' or ')}.` });
      return;
    }
    // Another site's page cannot make its visitors post, answer, spend model calls or sign out here.
    if (req.method === 'POST' && crossSite(req)) {
      sendJson(res, 403, { error: 'cross_site', message: 'Requests from other sites are not accepted.' });
      return;
    }
    try {
      await handler(req, res);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status = error instanceof ApiError ? error.status : (error as { status?: number }).status ?? 500;
      const code = error instanceof ApiError ? error.code : 'error';
      // Our own errors are written for people; anything else may carry internals, so it stays in the log. So do the
      // database's own words (its host, Postgres messages): the owner reads them in /api/health and the logs.
      const storage = error instanceof ApiError && status >= 500 && STORAGE_CODES.has(code);
      const message = error instanceof ApiError && !storage ? error.message : status >= 500 ? 'Something went wrong on our side. Try again in a moment.' : error instanceof Error ? error.message : String(error);
      if (storage) console.error(`[api] ${req.method} ${req.url}: ${(error as Error).message}`);
      if (status >= 500) console.error(`[api] ${req.method} ${req.url}:`, error);
      sendJson(res, status >= 400 && status < 600 ? status : 500, { error: code, message });
    } finally {
      // The model calls this request made, counted in memory, are saved once the response is out, before the
      // function may be frozen (lib/model-usage.ts).
      await saveModelUsage();
    }
  };
}

interface SseStream {
  send(event: string, data: unknown): void;
  close(): void;
  readonly closed: boolean;
}

/** Starts a server-sent-events response. Vercel's Node runtime streams `res.write` as-is. */
export function startSse(_req: ApiRequest, res: ApiResponse): SseStream {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  res.setHeader('x-accel-buffering', 'no');
  res.flushHeaders?.();
  let closed = false;
  // The response's 'close', not the request's: the request closes once its body is read, long before the client leaves.
  res.on('close', () => {
    closed = true;
  });
  return {
    get closed() {
      return closed;
    },
    send(event, data) {
      if (closed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      if (closed) return;
      closed = true;
      res.end();
    },
  };
}
