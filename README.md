# E-commerce REST API

[![CI](https://github.com/bahriy-dev/ecommerce-rest-api/actions/workflows/ci.yml/badge.svg)](https://github.com/bahriy-dev/ecommerce-rest-api/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%E2%89%A522.18-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-node%3Asqlite-003B57?logo=sqlite&logoColor=white)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A complete e-commerce backend (REST API) for a small online store: catalog, cart, checkout and
order management, built with **zero runtime dependencies** on Node.js 22+ (`node:http`,
`node:sqlite`, `node:crypto`).

It focuses on the parts that usually go wrong in real shops:

- **No overselling.** Checkout runs in one SQLite transaction and decrements stock with a guarded
  `UPDATE … WHERE stock >= ?`. Two customers racing for the last item: one gets the order, the other a `409`.
- **Safe retries.** `POST /orders` accepts an `Idempotency-Key` header. A double-clicked "Pay" button creates one order.
- **Correct money.** Prices are integer kuruş, VAT-inclusive, with per-product Turkish VAT (KDV) rates of 0, 1, 10 or 20 %.
- **Discount coupons.** Percent or fixed-amount codes with minimum cart value, usage limit and
  expiry. Usage is counted inside the checkout transaction and given back if the order is cancelled.
- **Order workflow.** `pending → paid → shipped → delivered`, or `cancelled`, which puts the stock back.
- **Secure auth.** scrypt password hashes, HS256 JWTs verified in constant time, no user enumeration on login.

## Quick start

```bash
git clone https://github.com/bahriy-dev/ecommerce-rest-api.git
cd ecommerce-rest-api
npm start      # http://localhost:3000/api/v1 (seeds an admin and 3 demo products)
npm test       # 40 tests: unit + full HTTP flows
```

With Docker:

```bash
docker build -t ecommerce-api .
docker run -p 3000:3000 -e JWT_SECRET=change-me -v shop-data:/data ecommerce-api
```

## API

All routes are under `/api/v1`. Send `Authorization: Bearer <token>` for protected routes.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/auth/register` | — | Create a customer account, returns a JWT |
| `POST` | `/auth/login` | — | Log in, returns a JWT |
| `GET` | `/me` | user | Current user |
| `GET` | `/categories` | — | Categories |
| `GET` | `/products` | — | Search, filter and paginate (see below) |
| `GET` | `/products/:id` | — | Product detail |
| `POST` | `/products` | admin | Create a product |
| `PATCH` | `/products/:id` | admin | Update any field |
| `DELETE` | `/products/:id` | admin | Soft delete (keeps order history intact) |
| `GET` | `/cart` | user | Cart lines, availability and totals |
| `PUT` | `/cart/items/:productId` | user | Set quantity (`0` removes) |
| `DELETE` | `/cart` | user | Empty the cart |
| `PUT` | `/cart/coupon` | user | Apply a coupon code (`{ "code": "HOSGELDIN10" }`) |
| `DELETE` | `/cart/coupon` | user | Remove the coupon |
| `POST` | `/orders` | user | Checkout. Supports `Idempotency-Key` |
| `GET` | `/orders` | user | My orders (`?all=true` for admins) |
| `GET` | `/orders/:id` | user | Order detail (owner or admin) |
| `POST` | `/orders/:id/cancel` | user | Cancel a pending order |
| `PATCH` | `/orders/:id/status` | admin | Move an order through the workflow |
| `GET` | `/coupons` | admin | List coupons with usage counts |
| `POST` | `/coupons` | admin | Create a coupon |
| `DELETE` | `/coupons/:code` | admin | Deactivate a coupon |

**Product query parameters:** `q`, `category` (slug), `minPrice`, `maxPrice` (kuruş),
`inStock=true`, `sort` (`newest`, `price_asc`, `price_desc`, `name`), `page`, `limit` (max 100).

### Example: checkout

```bash
TOKEN=$(curl -s localhost:3000/api/v1/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"ayse@example.com","name":"Ayşe","password":"password123"}' | jq -r .token)

curl -X PUT localhost:3000/api/v1/cart/items/1 -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"quantity":2}'

curl -X POST localhost:3000/api/v1/orders -H "Authorization: Bearer $TOKEN" \
  -H 'Idempotency-Key: 6f1c…' -H 'Content-Type: application/json' \
  -d '{"shippingAddress":"Caferağa Mah. Moda Cad. No:1, Kadıköy, İstanbul 34710"}'
```

```json
{
  "id": 1,
  "status": "pending",
  "subtotal": 499800,
  "vatTotal": 83300,
  "shipping": 0,
  "total": 499800,
  "items": [{ "productId": 1, "name": "Mekanik Klavye", "unitPrice": 249900, "vatRate": 20, "quantity": 2 }]
}
```

### Example: coupon

```bash
# admin: 10% off orders of 500 TL or more, 1000 uses, valid until the end of the year
curl -X POST localhost:3000/api/v1/coupons -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"code":"HOSGELDIN10","type":"percent","value":10,"minSubtotal":50000,"maxUses":1000,"expiresAt":"2026-12-31T23:59:59+03:00"}'

# customer
curl -X PUT localhost:3000/api/v1/cart/coupon -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"code":"hosgeldin10"}'
```

The cart and the order then show `discount` and `couponCode`. The discount is spread over the
cart lines and VAT is recalculated per line on the discounted amount; the free-shipping threshold
is checked after the discount. If an applied coupon expires, runs out or no longer meets the
minimum, the cart keeps showing it with `usable: false` and a `reason`, and stops applying it.

Errors always look like `{ "error": "…", "details": { … } }`. Validation errors return `422`
with one message per field.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATABASE_PATH` | `data.db` | SQLite file (`:memory:` for throwaway runs) |
| `JWT_SECRET` | dev value | **Required in production** |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `admin@example.com` / `admin12345` | First admin, created once |
| `SHIPPING_FEE` | `4990` | Flat shipping fee in kuruş |
| `FREE_SHIPPING_OVER` | `50000` | Free shipping threshold in kuruş |
| `CORS_ORIGIN` | `*` | Allowed origin |
| `LOG_REQUESTS` | — | `1` logs method, path, status and duration |

## Project layout

```
src/
  http.ts        router, JSON body parsing, errors
  auth.ts        scrypt passwords, JWT, role guards
  validate.ts    tiny schema validator (422 with per-field errors)
  db.ts          schema migrations (PRAGMA user_version), transactions, seed data
  pricing.ts     VAT, coupon discounts, shipping and totals in integer kuruş
  coupons.ts     coupon lookup and validity checks (expiry, usage limit)
  routes/        auth, catalog, cart, orders, coupons
  app.ts         wiring, CORS, error handling
test/            node:test unit tests and end-to-end HTTP tests
```

## License

MIT © [Bahri YILMAZ](https://bahriyilmaz.dev)
