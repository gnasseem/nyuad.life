/** Small helpers shared by every API route so handlers stay readable and behave the same on Vercel and the dev server. */
import type { IncomingMessage, ServerResponse } from 'node:http';

export type ApiRequest = IncomingMessage & {
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
};
export type ApiResponse = ServerResponse;
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

export function cors(res: ApiResponse): void {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-max-age', '86400');
}

export function sendJson(res: ApiResponse, status: number, body: unknown, cacheSeconds = 0): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', cacheSeconds > 0 ? `public, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 4}` : 'no-store');
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

export function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (first ?? '').split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
}

/**
 * In-memory token bucket per client IP and scope, so browsing never eats into the ask budget; resets whenever the
 * function instance recycles, which is fine for abuse control.
 */
const buckets = new Map<string, { tokens: number; updated: number }>();
export function rateLimit(req: IncomingMessage, capacity: number, perMinute: number, scope = 'default'): void {
  const ip = `${scope}:${clientIp(req)}`;
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

/** Wraps a handler with CORS, OPTIONS, method checks and uniform error JSON. */
export function route(methods: Array<'GET' | 'POST'>, handler: Handler): Handler {
  return async (req, res) => {
    cors(res);
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (!methods.includes((req.method ?? 'GET') as 'GET' | 'POST')) {
      sendJson(res, 405, { error: 'method_not_allowed', message: `Use ${methods.join(' or ')}.` });
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
      const message = error instanceof Error ? error.message : String(error);
      if (status >= 500) console.error(`[api] ${req.method} ${req.url}:`, error);
      sendJson(res, status >= 400 && status < 600 ? status : 500, { error: code, message });
    }
  };
}

export interface SseStream {
  send(event: string, data: unknown): void;
  close(): void;
  readonly closed: boolean;
}

/** Starts a server-sent-events response. Vercel's Node runtime streams `res.write` as-is. */
export function startSse(req: ApiRequest, res: ApiResponse): SseStream {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  res.setHeader('x-accel-buffering', 'no');
  res.flushHeaders?.();
  let closed = false;
  req.on('close', () => {
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
