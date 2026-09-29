/** A tiny Node HTTP server that mounts api/*.ts the way Vercel does, plus the built web app from dist/. */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import type { ApiRequest, Handler } from './http.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

export interface DevServerOptions {
  root?: string;
  apiDir?: string;
  distDir?: string;
}

export function createApiServer(options: DevServerOptions = {}): Server {
  const root = options.root ?? process.cwd();
  const apiDir = options.apiDir ?? path.join(root, 'api');
  const dist = options.distDir ?? path.join(root, 'dist');
  const handlers = new Map<string, Promise<Handler>>();

  const loadHandler = (name: string): Promise<Handler> => {
    let pending = handlers.get(name);
    if (!pending) {
      pending = import(path.join(apiDir, `${name}.ts`)).then((module) => module.default as Handler);
      handlers.set(name, pending);
    }
    return pending;
  };

  const serveApi = async (req: IncomingMessage, res: ServerResponse, name: string): Promise<void> => {
    if (!/^[a-z-]+$/.test(name) || !existsSync(path.join(apiDir, `${name}.ts`))) {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'not_found', message: `No API route named ${name}.` }));
      return;
    }
    const handler = await loadHandler(name);
    const request = req as ApiRequest;
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    request.query = Object.fromEntries(url.searchParams.entries());
    if (req.method === 'POST' && (req.headers['content-type'] ?? '').includes('application/json')) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        request.body = raw ? JSON.parse(raw) : {};
      } catch {
        request.body = raw;
      }
    }
    await handler(request, res);
  };

  const serveStatic = (res: ServerResponse, pathname: string): void => {
    if (!existsSync(dist)) {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<p style="font-family:system-ui;padding:2rem">The API is running. Run <code>npm run build</code> to serve the web app from here, or <code>npx vite</code> for live development.</p>');
      return;
    }
    let file = path.join(dist, pathname === '/' ? 'index.html' : pathname);
    if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(dist, 'index.html');
    res.statusCode = 200;
    res.setHeader('content-type', MIME[path.extname(file)] ?? 'application/octet-stream');
    res.end(readFileSync(file));
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) await serveApi(req, res, url.pathname.slice(5).replace(/\/$/, ''));
      else serveStatic(res, url.pathname);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
      }
      res.end(JSON.stringify({ error: 'error', message: (error as Error).message }));
    }
  });
}
