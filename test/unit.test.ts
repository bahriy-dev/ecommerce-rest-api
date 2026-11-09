import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, signToken, verifyToken } from '../src/auth.ts';
import { calculateTotals, vatIncluded, formatTry } from '../src/pricing.ts';
import { validate } from '../src/validate.ts';
import { HttpError } from '../src/http.ts';

describe('passwords', () => {
  it('verifies the right password only', () => {
    const hash = hashPassword('correct horse');
    assert.equal(verifyPassword('correct horse', hash), true);
    assert.equal(verifyPassword('wrong horse', hash), false);
  });
  it('salts every hash', () => assert.notEqual(hashPassword('same'), hashPassword('same')));
});

describe('JWT', () => {
  it('round-trips a payload', () => {
    const payload = verifyToken(signToken({ sub: 7, role: 'admin' }, 's3cret'), 's3cret');
    assert.equal(payload?.sub, 7);
    assert.equal(payload?.role, 'admin');
  });
  it('rejects a token signed with another secret', () => {
    assert.equal(verifyToken(signToken({ sub: 1, role: 'customer' }, 'a'), 'b'), null);
  });
  it('rejects a tampered payload', () => {
    const [h, , s] = signToken({ sub: 1, role: 'customer' }, 'k').split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 1, role: 'admin', exp: 9e9 })).toString('base64url');
    assert.equal(verifyToken(`${h}.${forged}.${s}`, 'k'), null);
  });
  it('rejects an expired token', () => {
    assert.equal(verifyToken(signToken({ sub: 1, role: 'customer' }, 'k', -10), 'k'), null);
  });
});

describe('pricing', () => {
  it('extracts VAT from a VAT-inclusive price', () => {
    assert.equal(vatIncluded(12000, 20), 2000);
    assert.equal(vatIncluded(11000, 10), 1000);
    assert.equal(vatIncluded(5000, 0), 0);
  });
  it('charges shipping below the threshold and not above it', () => {
    const shipping = { fee: 4990, freeOver: 50000 };
    assert.equal(calculateTotals([{ unitPrice: 10000, vatRate: 20, quantity: 1 }], shipping).shipping, 4990);
    assert.equal(calculateTotals([{ unitPrice: 25000, vatRate: 20, quantity: 2 }], shipping).shipping, 0);
    assert.equal(calculateTotals([], shipping).total, 0);
  });
  it('formats Turkish lira', () => assert.match(formatTry(249900), /2\.499,00/));
});

describe('validate', () => {
  it('collects every error', () => {
    try {
      validate({ name: 'x', price: -1 }, { name: { type: 'string', min: 2 }, price: { type: 'int', min: 0 }, sku: { type: 'string' } });
      assert.fail('should throw');
    } catch (err) {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 422);
      assert.deepEqual(Object.keys(err.details as object).sort(), ['name', 'price', 'sku']);
    }
  });
  it('allows missing fields in partial mode', () => {
    assert.deepEqual(validate({ price: 5 }, { name: { type: 'string' }, price: { type: 'int' } }, { partial: true }), { price: 5 });
  });
});
