import { createServer } from 'node:http';
import { createApp } from './app.ts';
import { openDb, seed } from './db.ts';

const env = process.env;

if (env.NODE_ENV === 'production' && !env.JWT_SECRET) {
  console.error('JWT_SECRET must be set in production');
  process.exit(1);
}

const db = openDb(env.DATABASE_PATH ?? 'data.db');
seed(db, env.ADMIN_EMAIL ?? 'admin@example.com', env.ADMIN_PASSWORD ?? 'admin12345');

const handler = createApp({
  db,
  config: {
    jwtSecret: env.JWT_SECRET ?? 'dev-only-secret-change-me',
    corsOrigin: env.CORS_ORIGIN ?? '*',
    shipping: {
      fee: Number(env.SHIPPING_FEE ?? 4990),
      freeOver: Number(env.FREE_SHIPPING_OVER ?? 50000),
    },
  },
});

const port = Number(env.PORT ?? 3000);
const server = createServer(handler).listen(port, () => {
  console.log(`ecommerce-api listening on http://localhost:${port}/api/v1`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
}
