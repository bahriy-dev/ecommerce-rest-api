import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerCustomer, loginAdmin, type TestApp } from './helpers.ts';
import { couponDiscount, calculateTotals } from '../src/pricing.ts';

describe('couponDiscount', () => {
  it('applies percent and fixed coupons', () => {
    assert.equal(couponDiscount({ type: 'percent', value: 10, minSubtotal: 0 }, 32000), 3200);
    assert.equal(couponDiscount({ type: 'fixed', value: 5000, minSubtotal: 0 }, 32000), 5000);
  });
  it('never discounts more than the subtotal', () => {
    assert.equal(couponDiscount({ type: 'fixed', value: 99999, minSubtotal: 0 }, 1000), 1000);
  });
  it('respects the minimum subtotal', () => {
    assert.equal(couponDiscount({ type: 'percent', value: 10, minSubtotal: 50000 }, 49999), 0);
  });
  it('lowers VAT and can drop below the free-shipping threshold', () => {
    const lines = [{ unitPrice: 60000, vatRate: 20, quantity: 1 }];
    const t = calculateTotals(lines, { fee: 4990, freeOver: 50000 }, { type: 'percent', value: 20, minSubtotal: 0 });
    assert.deepEqual(t, { subtotal: 60000, discount: 12000, vatTotal: 8000, shipping: 4990, total: 52990 });
  });
});

describe('coupons API', () => {
  let app: TestApp;
  let admin: string;
  before(async () => {
    app = await startApp();
    admin = await loginAdmin(app);
  });
  after(() => app.close());

  const productId = (sku: string) => (app.db.prepare('SELECT id FROM products WHERE sku = ?').get(sku) as { id: number }).id;
  const usedCount = (code: string) => (app.db.prepare('SELECT used_count AS n FROM coupons WHERE code = ?').get(code) as { n: number }).n;
  const createCoupon = (body: object) => app.request('POST', '/coupons', { token: admin, body });

  it('lets only admins create coupons and validates them', async () => {
    const customer = await registerCustomer(app);
    assert.equal((await app.request('POST', '/coupons', { token: customer, body: { code: 'X10', type: 'percent', value: 10 } })).status, 403);
    assert.equal((await createCoupon({ code: 'BAD', type: 'percent', value: 150 })).status, 422);
    const res = await createCoupon({ code: 'hosgeldin10', type: 'percent', value: 10 });
    assert.equal(res.status, 201);
    assert.equal(res.body.code, 'HOSGELDIN10');
    assert.equal((await createCoupon({ code: 'HOSGELDIN10', type: 'fixed', value: 100 })).status, 409);
  });

  it('applies a coupon to the cart and records it on the order', async () => {
    const token = await registerCustomer(app);
    await app.request('PUT', `/cart/items/${productId('KTP-003')}`, { token, body: { quantity: 1 } });
    const cart = await app.request('PUT', '/cart/coupon', { token, body: { code: 'hosgeldin10' } });
    assert.equal(cart.status, 200);
    assert.equal(cart.body.coupon.code, 'HOSGELDIN10');
    assert.deepEqual(cart.body.totals, { subtotal: 32000, discount: 3200, vatTotal: 0, shipping: 4990, total: 33790 });

    const order = await app.request('POST', '/orders', { token, body: { shippingAddress: 'Moda, Kadıköy, İstanbul 34710' } });
    assert.equal(order.status, 201);
    assert.equal(order.body.discount, 3200);
    assert.equal(order.body.couponCode, 'HOSGELDIN10');
    assert.equal(order.body.total, 33790);
    assert.equal(usedCount('HOSGELDIN10'), 1);
    assert.equal((await app.request('GET', '/cart', { token })).body.coupon, null);
  });

  it('enforces the usage limit and gives the use back on cancel', async () => {
    await createCoupon({ code: 'TEK', type: 'fixed', value: 1000, maxUses: 1 });
    const [a, b] = [await registerCustomer(app), await registerCustomer(app)];
    for (const token of [a, b]) {
      await app.request('PUT', `/cart/items/${productId('MOU-002')}`, { token, body: { quantity: 1 } });
      assert.equal((await app.request('PUT', '/cart/coupon', { token, body: { code: 'TEK' } })).status, 200);
    }
    const first = await app.request('POST', '/orders', { token: a, body: { shippingAddress: 'Çankaya, Ankara 06420' } });
    assert.equal(first.status, 201);
    const second = await app.request('POST', '/orders', { token: b, body: { shippingAddress: 'Konak, İzmir 35250' } });
    assert.equal(second.status, 409);
    assert.match(second.body.error, /usage limit/);

    await app.request('POST', `/orders/${first.body.id}/cancel`, { token: a });
    assert.equal(usedCount('TEK'), 0);
    assert.equal((await app.request('POST', '/orders', { token: b, body: { shippingAddress: 'Konak, İzmir 35250' } })).status, 201);
  });

  it('rejects expired, unknown and below-minimum coupons', async () => {
    await createCoupon({ code: 'ESKI', type: 'percent', value: 50, expiresAt: '2020-01-01T00:00:00Z' });
    await createCoupon({ code: 'BUYUK', type: 'percent', value: 15, minSubtotal: 1_000_000 });
    const token = await registerCustomer(app);
    await app.request('PUT', `/cart/items/${productId('KTP-003')}`, { token, body: { quantity: 1 } });
    assert.equal((await app.request('PUT', '/cart/coupon', { token, body: { code: 'ESKI' } })).status, 409);
    assert.equal((await app.request('PUT', '/cart/coupon', { token, body: { code: 'YOKBOYLE' } })).status, 404);
    const below = await app.request('PUT', '/cart/coupon', { token, body: { code: 'BUYUK' } });
    assert.equal(below.status, 409);
    assert.match(below.body.error, /at least/);
  });

  it('stops working once an admin deactivates it', async () => {
    await createCoupon({ code: 'KAPAT', type: 'fixed', value: 500 });
    const token = await registerCustomer(app);
    await app.request('PUT', `/cart/items/${productId('KTP-003')}`, { token, body: { quantity: 1 } });
    await app.request('PUT', '/cart/coupon', { token, body: { code: 'KAPAT' } });
    assert.equal((await app.request('DELETE', '/coupons/KAPAT', { token: admin })).status, 204);
    assert.equal((await app.request('GET', '/cart', { token })).body.totals.discount, 0);
  });
});
