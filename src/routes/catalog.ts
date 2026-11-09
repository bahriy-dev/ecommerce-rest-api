import type { Router } from '../http.ts';
import { HttpError, withStatus } from '../http.ts';
import { requireAdmin } from '../auth.ts';
import { validate, intParam, type Schema } from '../validate.ts';
import type { AppDeps } from '../app.ts';

const PRODUCT_COLUMNS = `p.id, p.sku, p.name, p.description, p.price, p.vat_rate AS vatRate, p.stock,
  p.is_active AS isActive, c.slug AS category`;

const productSchema: Schema = {
  sku: { type: 'string', min: 2, max: 40, pattern: /^[A-Z0-9-]+$/ },
  name: { type: 'string', min: 2, max: 200 },
  description: { type: 'string', max: 5000, optional: true },
  price: { type: 'int', min: 0, max: 100_000_000 },
  vatRate: { type: 'enum', values: ['0', '1', '10', '20'], optional: true },
  stock: { type: 'int', min: 0, max: 1_000_000 },
  categoryId: { type: 'int', min: 1, optional: true },
  isActive: { type: 'boolean', optional: true },
};

const SORTS: Record<string, string> = {
  newest: 'p.id DESC',
  price_asc: 'p.price ASC',
  price_desc: 'p.price DESC',
  name: 'p.name COLLATE NOCASE ASC',
};

type ProductInput = {
  sku?: string; name?: string; description?: string; price?: number;
  vatRate?: string; stock?: number; categoryId?: number; isActive?: boolean;
};

function normalize(body: unknown): unknown {
  // Accept vatRate as a number in JSON, validate it as an enum string.
  if (body && typeof body === 'object' && 'vatRate' in body && typeof (body as { vatRate: unknown }).vatRate === 'number') {
    return { ...body, vatRate: String((body as { vatRate: number }).vatRate) };
  }
  return body;
}

export function catalogRoutes(r: Router, { db }: AppDeps): void {
  r.get('/categories', () => db.prepare('SELECT id, name, slug FROM categories ORDER BY name').all());

  r.get('/products', ({ query, user }) => {
    const page = intParam(query.get('page'), 1, 1, 10_000);
    const limit = intParam(query.get('limit'), 20, 1, 100);
    const where: string[] = [];
    const args: (string | number)[] = [];

    if (user?.role !== 'admin') where.push('p.is_active = 1');
    const q = query.get('q')?.trim();
    if (q) {
      where.push('(p.name LIKE ? OR p.sku LIKE ?)');
      args.push(`%${q}%`, `%${q}%`);
    }
    const category = query.get('category');
    if (category) {
      where.push('c.slug = ?');
      args.push(category);
    }
    const minPrice = query.get('minPrice');
    if (minPrice) { where.push('p.price >= ?'); args.push(intParam(minPrice, 0, 0, Number.MAX_SAFE_INTEGER)); }
    const maxPrice = query.get('maxPrice');
    if (maxPrice) { where.push('p.price <= ?'); args.push(intParam(maxPrice, 0, 0, Number.MAX_SAFE_INTEGER)); }
    if (query.get('inStock') === 'true') where.push('p.stock > 0');

    const sort = SORTS[query.get('sort') ?? 'newest'] ?? SORTS.newest;
    const from = `FROM products p LEFT JOIN categories c ON c.id = p.category_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;

    const { total } = db.prepare(`SELECT COUNT(*) AS total ${from}`).get(...args) as { total: number };
    const items = db
      .prepare(`SELECT ${PRODUCT_COLUMNS} ${from} ORDER BY ${sort} LIMIT ? OFFSET ?`)
      .all(...args, limit, (page - 1) * limit);

    return { items, page, limit, total, totalPages: Math.ceil(total / limit) };
  });

  r.get('/products/:id', ({ params, user }) => {
    const product = db
      .prepare(`SELECT ${PRODUCT_COLUMNS} FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?`)
      .get(Number(params.id)) as { isActive: number } | undefined;
    if (!product || (!product.isActive && user?.role !== 'admin')) throw new HttpError(404, 'Product not found');
    return product;
  });

  // ---------- Admin ----------

  r.post('/products', (ctx) => {
    requireAdmin(ctx);
    const p = validate<ProductInput>(normalize(ctx.body), productSchema);
    if (db.prepare('SELECT 1 FROM products WHERE sku = ?').get(p.sku!)) throw new HttpError(409, 'SKU already exists');
    const { lastInsertRowid } = db
      .prepare(`INSERT INTO products (sku, name, description, price, vat_rate, stock, category_id, is_active)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(p.sku!, p.name!, p.description ?? '', p.price!, Number(p.vatRate ?? 20), p.stock!, p.categoryId ?? null, p.isActive === false ? 0 : 1);
    return withStatus(201, { id: Number(lastInsertRowid), ...p });
  });

  r.patch('/products/:id', (ctx) => {
    requireAdmin(ctx);
    const p = validate<ProductInput>(normalize(ctx.body), productSchema, { partial: true });
    const columns: Record<string, string> = {
      sku: 'sku', name: 'name', description: 'description', price: 'price',
      vatRate: 'vat_rate', stock: 'stock', categoryId: 'category_id', isActive: 'is_active',
    };
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    for (const [key, value] of Object.entries(p)) {
      sets.push(`${columns[key]} = ?`);
      args.push(key === 'isActive' ? (value ? 1 : 0) : key === 'vatRate' ? Number(value) : (value as string | number));
    }
    if (!sets.length) throw new HttpError(400, 'Nothing to update');
    const { changes } = db.prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`).run(...args, Number(ctx.params.id));
    if (!changes) throw new HttpError(404, 'Product not found');
    return { id: Number(ctx.params.id), updated: Object.keys(p) };
  });

  r.delete('/products/:id', (ctx) => {
    requireAdmin(ctx);
    // Soft delete: products referenced by past orders must keep existing.
    const { changes } = db.prepare('UPDATE products SET is_active = 0 WHERE id = ?').run(Number(ctx.params.id));
    if (!changes) throw new HttpError(404, 'Product not found');
    return withStatus(204, null);
  });
}
