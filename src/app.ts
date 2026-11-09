import type { IncomingMessage, ServerResponse } from 'node:http';
import { Router, HttpError, readBody, sendJson, type Context } from './http.ts';
import { bearerToken, verifyToken } from './auth.ts';
import type { Db } from './db.ts';
import type { ShippingRule } from './pricing.ts';
import { authRoutes } from './routes/auth.ts';
import { catalogRoutes } from './routes/catalog.ts';
import { cartRoutes } from './routes/cart.ts';
import { orderRoutes } from './routes/orders.ts';

export interface Config {
  jwtSecret: string;
  shipping: ShippingRule;
  corsOrigin: string;
}

export interface AppDeps {
  db: Db;
  config: Config;
}

export function createApp(deps: AppDeps) {
  const router = new Router();
  router.get('/health', () => ({ status: 'ok' }));
  authRoutes(router, deps);
  catalogRoutes(router, deps);
  cartRoutes(router, deps);
  orderRoutes(router, deps);

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = performance.now();
    res.setHeader('Access-Control-Allow-Origin', deps.config.corsOrigin);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    try {
      if (req.method === 'OPTIONS') return sendJson(res, 204, null);

      const url = new URL(req.url ?? '/', 'http://localhost');
      const pathname = url.pathname.replace(/^\/api\/v1/, '') || '/';
      const match = router.match(req.method ?? 'GET', pathname);
      if (!match) throw new HttpError(404, 'Not found');

      const token = bearerToken(req.headers.authorization);
      const payload = token ? verifyToken(token, deps.config.jwtSecret) : null;
      if (token && !payload) throw new HttpError(401, 'Invalid or expired token');

      const ctx: Context = {
        req,
        res,
        params: match.params,
        query: url.searchParams,
        body: await readBody(req),
        user: payload ? { id: payload.sub, role: payload.role } : null,
      };

      const result = (await match.handler(ctx)) as { __status?: number; body?: unknown } | undefined;
      if (result && typeof result === 'object' && '__status' in result) sendJson(res, result.__status!, result.body);
      else sendJson(res, 200, result ?? null);
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message, ...(err.details ? { details: err.details } : {}) });
      } else {
        console.error(err);
        sendJson(res, 500, { error: 'Internal server error' });
      }
    } finally {
      if (process.env.LOG_REQUESTS === '1') {
        console.log(`${req.method} ${req.url} ${res.statusCode} ${(performance.now() - started).toFixed(1)}ms`);
      }
    }
  };
}
