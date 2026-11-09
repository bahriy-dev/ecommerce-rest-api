import type { Router } from '../http.ts';
import { HttpError, withStatus } from '../http.ts';
import { hashPassword, verifyPassword, signToken, requireUser } from '../auth.ts';
import { validate } from '../validate.ts';
import type { AppDeps } from '../app.ts';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function authRoutes(r: Router, { db, config }: AppDeps): void {
  r.post('/auth/register', ({ body }) => {
    const input = validate<{ email: string; name: string; password: string }>(body, {
      email: { type: 'string', pattern: EMAIL, max: 254 },
      name: { type: 'string', min: 2, max: 100 },
      password: { type: 'string', min: 8, max: 128 },
    });
    const exists = db.prepare('SELECT 1 FROM users WHERE email = ?').get(input.email);
    if (exists) throw new HttpError(409, 'Email is already registered');

    const { lastInsertRowid } = db
      .prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)')
      .run(input.email, input.name, hashPassword(input.password));
    const id = Number(lastInsertRowid);
    return withStatus(201, {
      user: { id, email: input.email, name: input.name, role: 'customer' },
      token: signToken({ sub: id, role: 'customer' }, config.jwtSecret),
    });
  });

  r.post('/auth/login', ({ body }) => {
    const input = validate<{ email: string; password: string }>(body, {
      email: { type: 'string' },
      password: { type: 'string' },
    });
    const user = db
      .prepare('SELECT id, email, name, role, password_hash FROM users WHERE email = ?')
      .get(input.email) as { id: number; email: string; name: string; role: 'customer' | 'admin'; password_hash: string } | undefined;
    // Same error for unknown email and wrong password, so accounts can't be enumerated.
    if (!user || !verifyPassword(input.password, user.password_hash)) {
      throw new HttpError(401, 'Invalid email or password');
    }
    return {
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      token: signToken({ sub: user.id, role: user.role }, config.jwtSecret),
    };
  });

  r.get('/me', (ctx) => {
    const { id } = requireUser(ctx);
    return db.prepare('SELECT id, email, name, role, created_at AS createdAt FROM users WHERE id = ?').get(id);
  });
}
