import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, registerCustomer, loginAdmin, type TestApp } from './helpers.ts';

let app: TestApp;
before(async () => { app = await startApp(); });
after(() => app.close());

describe('auth', () => {
  it('registers, logs in and returns the profile', async () => {
    const reg = await app.request('POST', '/auth/register', { body: { email: 'ayse@example.com', name: 'Ayşe', password: 'password123' } });
    assert.equal(reg.status, 201);
    const login = await app.request('POST', '/auth/login', { body: { email: 'AYSE@example.com', password: 'password123' } });
    assert.equal(login.status, 200);
    const me = await app.request('GET', '/me', { token: login.body.token });
    assert.equal(me.body.email, 'ayse@example.com');
  });
  it('rejects duplicate emails', async () => {
    const res = await app.request('POST', '/auth/register', { body: { email: 'ayse@example.com', name: 'Ayşe', password: 'password123' } });
    assert.equal(res.status, 409);
  });
  it('returns 422 with field errors', async () => {
    const res = await app.request('POST', '/auth/register', { body: { email: 'nope', name: 'A', password: '1' } });
    assert.equal(res.status, 422);
    assert.deepEqual(Object.keys(res.body.details).sort(), ['email', 'name', 'password']);
  });
  it('uses the same error for wrong password and unknown user', async () => {
    const a = await app.request('POST', '/auth/login', { body: { email: 'ayse@example.com', password: 'wrong-pass' } });
    const b = await app.request('POST', '/auth/login', { body: { email: 'ghost@example.com', password: 'wrong-pass' } });
    assert.equal(a.status, 401);
    assert.deepEqual(a.body, b.body);
  });
  it('rejects a bad token', async () => {
    assert.equal((await app.request('GET', '/me', { token: 'x.y.z' })).status, 401);
  });
});

describe('catalog', () => {
  it('lists, filters, sorts and paginates products', async () => {
    const all = await app.request('GET', '/products?sort=price_asc');
    assert.equal(all.body.total, 3);
    assert.ok(all.body.items[0].price <= all.body.items[1].price);

    const books = await app.request('GET', '/products?category=kitap');
    assert.equal(books.body.items.length, 1);

    const page = await app.request('GET', '/products?limit=2&page=2');
    assert.equal(page.body.items.length, 1);
    assert.equal(page.body.totalPages, 2);

    const search = await app.request('GET', '/products?q=klavye');
    assert.equal(search.body.items[0].sku, 'KLV-001');
  });

  it('only lets admins create products', async () => {
    const customer = await registerCustomer(app);
    const product = { sku: 'USB-100', name: 'USB-C Kablo', price: 19900, vatRate: 20, stock: 3 };
    assert.equal((await app.request('POST', '/products', { token: customer, body: product })).status, 403);
    assert.equal((await app.request('POST', '/products')).status, 401);

    const admin = await loginAdmin(app);
    const created = await app.request('POST', '/products', { token: admin, body: product });
    assert.equal(created.status, 201);
    assert.equal((await app.request('POST', '/products', { token: admin, body: product })).status, 409);
  });

  it('hides soft-deleted products from customers', async () => {
    const admin = await loginAdmin(app);
    const { body } = await app.request('GET', '/products?q=USB-100');
    const id = body.items[0].id;
    assert.equal((await app.request('DELETE', `/products/${id}`, { token: admin })).status, 204);
    assert.equal((await app.request('GET', `/products/${id}`)).status, 404);
    assert.equal((await app.request('GET', `/products/${id}`, { token: admin })).status, 200);
  });

  it('returns 405 for a known path with the wrong method', async () => {
    assert.equal((await app.request('PUT', '/products')).status, 405);
  });
});

describe('cart & checkout', () => {
  const productId = (sku: string) =>
    (app.db.prepare('SELECT id FROM products WHERE sku = ?').get(sku) as { id: number }).id;
  const stock = (sku: string) =>
    (app.db.prepare('SELECT stock FROM products WHERE sku = ?').get(sku) as { stock: number }).stock;

  it('calculates totals with VAT and shipping', async () => {
    const token = await registerCustomer(app);
    const cart = await app.request('PUT', `/cart/items/${productId('KTP-003')}`, { token, body: { quantity: 1 } });
    assert.equal(cart.status, 200);
    assert.deepEqual(cart.body.totals, { subtotal: 32000, discount: 0, vatTotal: 0, shipping: 4990, total: 36990 });
  });

  it('refuses quantities above stock', async () => {
    const token = await registerCustomer(app);
    const res = await app.request('PUT', `/cart/items/${productId('KLV-001')}`, { token, body: { quantity: 99 } });
    assert.equal(res.status, 409);
  });

  it('places an order, decrements stock and empties the cart', async () => {
    const token = await registerCustomer(app);
    const before = stock('KLV-001');
    await app.request('PUT', `/cart/items/${productId('KLV-001')}`, { token, body: { quantity: 2 } });

    const order = await app.request('POST', '/orders', { token, body: { shippingAddress: 'Kadıköy, İstanbul 34710' } });
    assert.equal(order.status, 201);
    assert.equal(order.body.status, 'pending');
    assert.equal(order.body.total, 2 * 249900);
    assert.equal(order.body.vatTotal, 83300);
    assert.equal(order.body.shipping, 0);
    assert.equal(stock('KLV-001'), before - 2);
    assert.equal((await app.request('GET', '/cart', { token })).body.items.length, 0);
  });

  it('is idempotent with an Idempotency-Key header', async () => {
    const token = await registerCustomer(app);
    await app.request('PUT', `/cart/items/${productId('MOU-002')}`, { token, body: { quantity: 1 } });
    const opts = { token, body: { shippingAddress: 'Çankaya, Ankara 06420' }, headers: { 'Idempotency-Key': 'abc-123' } };
    const first = await app.request('POST', '/orders', opts);
    const second = await app.request('POST', '/orders', opts);
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(first.body.id, second.body.id);
  });

  it('never oversells the last item', async () => {
    const admin = await loginAdmin(app);
    await app.request('POST', '/products', { token: admin, body: { sku: 'LAST-1', name: 'Son Ürün', price: 1000, stock: 1 } });
    const [a, b] = [await registerCustomer(app), await registerCustomer(app)];
    for (const token of [a, b]) await app.request('PUT', `/cart/items/${productId('LAST-1')}`, { token, body: { quantity: 1 } });

    const results = await Promise.all([a, b].map((token) =>
      app.request('POST', '/orders', { token, body: { shippingAddress: 'Konak, İzmir 35250' } })));
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.equal(stock('LAST-1'), 0);
  });

  it('keeps orders private and restores stock on cancel', async () => {
    const owner = await registerCustomer(app);
    const other = await registerCustomer(app);
    const before = stock('MOU-002');
    await app.request('PUT', `/cart/items/${productId('MOU-002')}`, { token: owner, body: { quantity: 3 } });
    const order = await app.request('POST', '/orders', { token: owner, body: { shippingAddress: 'Nilüfer, Bursa 16110' } });
    assert.equal(stock('MOU-002'), before - 3);

    assert.equal((await app.request('GET', `/orders/${order.body.id}`, { token: other })).status, 404);
    const cancelled = await app.request('POST', `/orders/${order.body.id}/cancel`, { token: owner });
    assert.equal(cancelled.body.status, 'cancelled');
    assert.equal(stock('MOU-002'), before);
  });

  it('enforces the order status workflow', async () => {
    const token = await registerCustomer(app);
    const admin = await loginAdmin(app);
    await app.request('PUT', `/cart/items/${productId('KTP-003')}`, { token, body: { quantity: 1 } });
    const { body: order } = await app.request('POST', '/orders', { token, body: { shippingAddress: 'Merkez, Eskişehir 26010' } });

    const set = (status: string) => app.request('PATCH', `/orders/${order.id}/status`, { token: admin, body: { status } });
    assert.equal((await set('delivered')).status, 409);
    assert.equal((await set('paid')).status, 200);
    assert.equal((await set('shipped')).status, 200);
    assert.equal((await app.request('POST', `/orders/${order.id}/cancel`, { token })).status, 409);
    assert.equal((await set('delivered')).body.status, 'delivered');
  });
});
