import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { openDb, seed, type Db } from '../src/db.ts';

export interface TestApp {
  db: Db;
  server: Server;
  request: (method: string, path: string, opts?: { token?: string; body?: unknown; headers?: Record<string, string> }) =>
    Promise<{ status: number; body: any }>;
  close: () => void;
}

export async function startApp(): Promise<TestApp> {
  const db = openDb(':memory:');
  seed(db, 'admin@example.com', 'admin12345');
  const server = createServer(
    createApp({ db, config: { jwtSecret: 'test-secret', corsOrigin: '*', shipping: { fee: 4990, freeOver: 50000 } } }),
  );
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;

  return {
    db,
    server,
    async request(method, path, { token, body, headers = {} } = {}) {
      const res = await fetch(base + path, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    close() {
      server.close();
      db.close();
    },
  };
}

let counter = 0;
export async function registerCustomer(app: TestApp): Promise<string> {
  const res = await app.request('POST', '/auth/register', {
    body: { email: `user${++counter}@example.com`, name: 'Test User', password: 'password123' },
  });
  return res.body.token;
}

export async function loginAdmin(app: TestApp): Promise<string> {
  const res = await app.request('POST', '/auth/login', { body: { email: 'admin@example.com', password: 'admin12345' } });
  return res.body.token;
}
