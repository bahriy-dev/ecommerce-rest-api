import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  readonly status: number;
  readonly details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export interface Context {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  user: { id: number; role: 'customer' | 'admin' } | null;
}

export type Handler = (ctx: Context) => unknown | Promise<unknown>;
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface Route {
  method: Method;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

/** Minimal router: `/products/:id` style params, JSON in, JSON out. */
export class Router {
  private readonly routes: Route[] = [];

  on(method: Method, path: string, handler: Handler): this {
    const keys: string[] = [];
    const source = path.replace(/:(\w+)/g, (_, key: string) => {
      keys.push(key);
      return '([^/]+)';
    });
    this.routes.push({ method, pattern: new RegExp(`^${source}/?$`), keys, handler });
    return this;
  }

  get(path: string, h: Handler) { return this.on('GET', path, h); }
  post(path: string, h: Handler) { return this.on('POST', path, h); }
  put(path: string, h: Handler) { return this.on('PUT', path, h); }
  patch(path: string, h: Handler) { return this.on('PATCH', path, h); }
  delete(path: string, h: Handler) { return this.on('DELETE', path, h); }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.pattern.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      return { handler: route.handler, params };
    }
    if (pathMatched) throw new HttpError(405, 'Method not allowed');
    return null;
  }
}

const MAX_BODY = 256 * 1024;

export async function readBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'DELETE') return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Body too large');
    chunks.push(chunk);
  }
  if (size === 0) return undefined;
  if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
    throw new HttpError(415, 'Content-Type must be application/json');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (status === 204) return void res.writeHead(204).end();
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** Tells the router to answer with a non-200 status. */
export function withStatus(status: number, body: unknown) {
  return { __status: status, body };
}
