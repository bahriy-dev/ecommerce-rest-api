import { DatabaseSync } from 'node:sqlite';
import { hashPassword } from './auth.ts';

export type Db = DatabaseSync;

const MIGRATIONS: string[] = [
  `CREATE TABLE users (
     id            INTEGER PRIMARY KEY,
     email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
     name          TEXT NOT NULL,
     password_hash TEXT NOT NULL,
     role          TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'admin')),
     created_at    TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE categories (
     id   INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     slug TEXT NOT NULL UNIQUE
   );
   CREATE TABLE products (
     id          INTEGER PRIMARY KEY,
     category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
     sku         TEXT NOT NULL UNIQUE,
     name        TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     price       INTEGER NOT NULL CHECK (price >= 0),          -- kuruş, VAT included
     vat_rate    INTEGER NOT NULL DEFAULT 20 CHECK (vat_rate IN (0, 1, 10, 20)),
     stock       INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
     is_active   INTEGER NOT NULL DEFAULT 1,
     created_at  TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX products_category ON products(category_id);
   CREATE TABLE cart_items (
     user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
     quantity   INTEGER NOT NULL CHECK (quantity > 0),
     PRIMARY KEY (user_id, product_id)
   );
   CREATE TABLE orders (
     id               INTEGER PRIMARY KEY,
     user_id          INTEGER NOT NULL REFERENCES users(id),
     status           TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'paid', 'shipped', 'delivered', 'cancelled')),
     subtotal         INTEGER NOT NULL,
     vat_total        INTEGER NOT NULL,
     shipping         INTEGER NOT NULL,
     total            INTEGER NOT NULL,
     shipping_address TEXT NOT NULL,
     idempotency_key  TEXT,
     created_at       TEXT NOT NULL DEFAULT (datetime('now')),
     UNIQUE (user_id, idempotency_key)
   );
   CREATE TABLE order_items (
     order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
     product_id INTEGER NOT NULL REFERENCES products(id),
     name       TEXT NOT NULL,
     unit_price INTEGER NOT NULL,
     vat_rate   INTEGER NOT NULL,
     quantity   INTEGER NOT NULL,
     PRIMARY KEY (order_id, product_id)
   );`,
];

export function openDb(path = ':memory:'): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (let i = version; i < MIGRATIONS.length; i++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    });
  }
  return db;
}

/** Runs `fn` inside BEGIN/COMMIT and rolls back if it throws. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function seed(db: Db, adminEmail: string, adminPassword: string): void {
  const hasAdmin = db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get();
  if (!hasAdmin) {
    db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?, 'Admin', ?, 'admin')")
      .run(adminEmail, hashPassword(adminPassword));
  }
  const hasCatalog = db.prepare('SELECT 1 FROM products').get();
  if (hasCatalog) return;

  transaction(db, () => {
    const cat = db.prepare('INSERT INTO categories (name, slug) VALUES (?, ?)');
    const electronics = Number(cat.run('Elektronik', 'elektronik').lastInsertRowid);
    const books = Number(cat.run('Kitap', 'kitap').lastInsertRowid);
    const product = db.prepare(
      'INSERT INTO products (category_id, sku, name, description, price, vat_rate, stock) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    product.run(electronics, 'KLV-001', 'Mekanik Klavye', 'TR Q, hot-swap', 249900, 20, 25);
    product.run(electronics, 'MOU-002', 'Kablosuz Mouse', '2.4 GHz + Bluetooth', 89900, 20, 40);
    product.run(books, 'KTP-003', 'Temiz Kod', 'Yazılım zanaatkarlığı üzerine', 32000, 0, 100);
  });
}
