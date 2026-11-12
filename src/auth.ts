import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { HttpError, type Context } from './http.ts';

// ---------- Passwords (scrypt, per-user salt) ----------

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = scryptSync(password, Buffer.from(salt, 'base64url'), expected.length);
  return timingSafeEqual(actual, expected);
}

// ---------- JWT (HS256) ----------

export interface TokenPayload {
  sub: number;
  role: 'customer' | 'admin';
  iat: number;
  exp: number;
}

const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');

export function signToken(payload: Pick<TokenPayload, 'sub' | 'role'>, secret: string, ttlSeconds = 60 * 60 * 24): string {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ ...payload, iat: now, exp: now + ttlSeconds })}`;
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken(token: string, secret: string): TokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as TokenPayload;
    if (typeof data.exp !== 'number' || data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

export function bearerToken(header: string | undefined): string | null {
  // Tokens never contain whitespace; \S+ keeps the match linear on long headers.
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  return m ? m[1] : null;
}

// ---------- Guards ----------

export function requireUser(ctx: Context): { id: number; role: 'customer' | 'admin' } {
  if (!ctx.user) throw new HttpError(401, 'Authentication required');
  return ctx.user;
}

export function requireAdmin(ctx: Context): { id: number; role: 'admin' } {
  const user = requireUser(ctx);
  if (user.role !== 'admin') throw new HttpError(403, 'Admin role required');
  return user as { id: number; role: 'admin' };
}
