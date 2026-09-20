# @scos/persistence

The PostgreSQL side of SCOS: the Prisma schema and migrations, the
six-warehouse seed, and the driven adapters that implement
[`@scos/core`](../core/README.md)'s ports. It knows about SQL, connections and
row locks; it knows nothing about HTTP.

In [hexagonal terms](../../docs/architecture.md) this package sits on the
driven side. Core declares what it needs (`InventoryReader`, `SubmissionStore`)
and this package supplies it, so the dependency points inward: persistence
imports core, never the reverse.

## Layout

- `prisma/schema.prisma` and `prisma/migrations/`: the normalized schema for
  warehouses, orders and allocations. See
  [database schema](../../docs/database-schema.md) for the tables and
  [ADR 0003](../../docs/adr/0003-database-managed-timestamps.md) for the
  database-managed `created_at` / `updated_at` policy.
- `src/inventory-reader.ts`: reads a warehouse stock snapshot for core's
  `InventoryReader` port.
- `src/submission-store.ts`: the submission transaction — lock the warehouse
  rows, re-evaluate, write the order and its allocations, deduct stock, all in
  one transaction. Transaction-local lock and statement timeouts are set inside
  it, because Hyperdrive resets a connection when it returns to the pool
  ([ADR 0005](../../docs/adr/0005-cloudflare-first-deployment.md)).
- `src/submission-errors.ts`: classifies PostgreSQL failures (unique violation,
  lock timeout, connection timeout) into outcomes the use case can act on.
- `src/database.ts`, `src/prisma.ts`: connection pooling and Prisma client
  construction, with bounded connect and query timeouts. Two generated clients
  exist — the Node one and a workerd build for Cloudflare Workers.
- `src/seed.ts`, `src/bin/`: the reproducible six-warehouse seed and the guarded
  reset entry points.
- `src/records.ts`: row shapes and their conversion to and from domain types.

## Tests

The split matters, and CI relies on it:

- `src/*.test.ts` — unit tests beside their code. No database. Run with
  `pnpm test`.
- `test/*.integration.test.ts` — connectivity, migrations, schema, seed, the
  inventory reader, connection timeouts and transaction pooling, all against a
  **real PostgreSQL**. Run with `pnpm test:integration`, which CI runs as a
  separate, never-cached job against a disposable PostgreSQL 18 service.

Integration tests need `DATABASE_TEST_URL`. See the
[evaluator walkthrough](../../README.md#evaluator-walkthrough) for bringing the
databases up.

## Scripts

| Script                  | What it does                                                     |
| ----------------------- | ---------------------------------------------------------------- |
| `pnpm generate`         | Regenerates the Prisma clients from the schema                   |
| `pnpm db:migrate`       | Applies migrations (`prisma migrate deploy`)                     |
| `pnpm db:seed`          | Inserts the six warehouses                                       |
| `pnpm db:reset`         | Drops, re-migrates and re-seeds — guarded by a confirmation step |
| `pnpm test`             | Unit tests with coverage                                         |
| `pnpm test:integration` | Integration tests against a real PostgreSQL                      |
