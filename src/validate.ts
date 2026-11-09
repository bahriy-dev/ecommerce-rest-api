import { HttpError } from './http.ts';

/**
 * Tiny schema validator, so the API needs no runtime dependencies.
 * Collects every problem instead of stopping at the first one.
 */
type Rule =
  | { type: 'string'; min?: number; max?: number; pattern?: RegExp; optional?: boolean }
  | { type: 'int'; min?: number; max?: number; optional?: boolean }
  | { type: 'boolean'; optional?: boolean }
  | { type: 'enum'; values: readonly string[]; optional?: boolean };

export type Schema = Record<string, Rule>;

export function validate<T>(body: unknown, schema: Schema, { partial = false } = {}): T {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'Body must be a JSON object');
  }
  const input = body as Record<string, unknown>;
  const errors: Record<string, string> = {};
  const out: Record<string, unknown> = {};

  for (const [key, rule] of Object.entries(schema)) {
    const value = input[key];
    if (value === undefined || value === null) {
      if (!rule.optional && !partial) errors[key] = 'is required';
      continue;
    }
    const error = check(value, rule);
    if (error) errors[key] = error;
    else out[key] = typeof value === 'string' ? value.trim() : value;
  }

  if (Object.keys(errors).length) throw new HttpError(422, 'Validation failed', errors);
  return out as T;
}

function check(value: unknown, rule: Rule): string | null {
  switch (rule.type) {
    case 'string': {
      if (typeof value !== 'string') return 'must be a string';
      const v = value.trim();
      if (rule.min !== undefined && v.length < rule.min) return `must be at least ${rule.min} characters`;
      if (rule.max !== undefined && v.length > rule.max) return `must be at most ${rule.max} characters`;
      if (rule.pattern && !rule.pattern.test(v)) return 'has an invalid format';
      return null;
    }
    case 'int':
      if (!Number.isInteger(value)) return 'must be an integer';
      if (rule.min !== undefined && (value as number) < rule.min) return `must be >= ${rule.min}`;
      if (rule.max !== undefined && (value as number) > rule.max) return `must be <= ${rule.max}`;
      return null;
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be a boolean';
    case 'enum':
      return rule.values.includes(value as string) ? null : `must be one of: ${rule.values.join(', ')}`;
  }
}

export function intParam(value: string | null | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
