# Database schema

The Ordering persistence schema lives in `packages/persistence`:

- `prisma/schema.prisma`: Prisma models (snake_case tables and columns mapped to camelCase fields)
- `prisma/migrations/`: versioned SQL migrations, the source of truth for the database
- `src/seed.ts`: the six PRD warehouses and the non-destructive seed
- `src/records.ts`: typed mappings from Prisma rows to plain persistence records

Migrations are applied with `prisma migrate deploy`. The initial migration's table, index, and foreign-key DDL follows Prisma's generated output and was inspected; CHECK constraints and the timestamp defaults and triggers are hand-written SQL because Prisma cannot express them.

Only accepted Orders are stored. A business rejection is returned to the caller and never persisted, so the schema has no submission, rejection, or outcome tables.

## Entity relationships

```mermaid
erDiagram
    customer_order ||--|{ order_allocation : "fulfilled by"
    warehouse ||--o{ order_allocation : "supplies"

    warehouse {
        uuid id PK "UUIDv7, stable seed IDs"
        text name UK
        float8 latitude "-90..90"
        float8 longitude "-180..180"
        int stock ">= 0"
        timestamptz created_at
        timestamptz updated_at
    }
    customer_order {
        uuid id PK "uuidv7()"
        text order_number UK
        text submission_key UK "client submissionId, 1..255 chars"
        int quantity "> 0"
        float8 destination_latitude "-90..90"
        float8 destination_longitude "-180..180"
        numeric unit_price "12,2"
        numeric merchandise_subtotal "12,2; = unit_price * quantity"
        numeric discount_rate "3,2; 0..1"
        numeric discount_amount "12,2"
        numeric discounted_merchandise_total "12,2"
        numeric shipping_cost "12,2"
        numeric order_total "12,2"
        timestamptz created_at
        timestamptz updated_at
    }
    order_allocation {
        uuid id PK "uuidv7()"
        uuid order_id FK
        uuid warehouse_id FK
        int quantity "> 0"
        timestamptz created_at
        timestamptz updated_at
    }
```

`order_allocation` has a unique `(order_id, warehouse_id)` pair: one allocation per warehouse per Order.

## Tables

| Table              | Purpose                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------- |
| `warehouse`        | Warehouse location and current Warehouse Inventory (`stock`)                            |
| `customer_order`   | Accepted Order: duplicate-request key, Order Request, and immutable commercial snapshot |
| `order_allocation` | Warehouse Allocations of an accepted Order                                              |

## Decisions

### Normalization (3NF)

- Each fact is stored once and depends only on its table's key. Warehouses, Orders, and allocations are separate entities; relationships use foreign keys.
- The Order Request (quantity and destination) lives on the accepted Order, together with the client's `submission_key`. Every column of `customer_order` depends on the Order itself. Rejected requests are not stored at all: a request whose key has no accepted Order is evaluated fresh, so there is no separate attempt entity to normalize into.
- Commercial amounts on `customer_order` are a deliberate historical snapshot, as required by the design decisions: accepted prices, discounts, shipping, and totals are preserved rather than recalculated from current commercial rules. `merchandise_subtotal`, `discounted_merchandise_total`, and `order_total` are derivable from other columns in the same row. They are stored anyway because they are the exact amounts returned to the customer, and intra-row CHECKs keep them consistent (`subtotal = unit_price * quantity`, `discounted = subtotal - discount`, `total = discounted + shipping`). The discount rounding rule belongs to the domain and is not enforced by the schema.
- `unit_price` is stored so that each snapshot records the applied price alongside the amounts derived from it.
- The subtotal CHECK multiplies `NUMERIC(12,2)` by an `integer` in unbounded `NUMERIC`, so the comparison is exact at every quantity. A product beyond `NUMERIC(12,2)` cannot be stored in `merchandise_subtotal` at all: the insert fails with a numeric overflow (`22003`) before any CHECK is evaluated, so the constraint never silently accepts a rounded subtotal.

### Identifiers and keys

- Generated entity IDs are PostgreSQL `uuid` values with a `uuidv7()` default (PostgreSQL 18 built-in). Referencing foreign keys use `uuid`. Prisma declares them as `@default(dbgenerated("uuidv7()")) @db.Uuid`, so PostgreSQL generates them.
- Seeded warehouse IDs are fixed UUIDv7 values (`01996000-0000-7000-8000-00000000000N`), ordered in PRD list order. They never change, so row-lock order and equal-distance tie-breaking stay stable. UUIDv7 ordering is not a commit-order guarantee; queries use explicit `ORDER BY`.
- `customer_order.submission_key` stores the client's `submissionId` as a unique duplicate-request key: one accepted Order per key. The schema requires it to be non-blank (`btrim(submission_key) <> ''`, matching `order_number` and warehouse `name`) and at most 255 characters (`char_length(submission_key) <= 255`). PostgreSQL's single-argument `btrim` removes spaces only, so a key made only of tabs or newlines passes this check; #11 validates the key format at the API boundary. Any stricter format belongs to the API contract, which must stay within this limit.
- `customer_order.order_number` is unique and non-empty; its format is decided when submission is implemented.
- The Order table is named `customer_order` because `order` is a reserved SQL keyword and would need quoting in every raw query, including the planned row-locking SQL. The Prisma model is still `Order`.

### Categorical values

- No categorical value is persisted: the only stored outcome is an accepted Order, and rejections are returned rather than stored. The schema therefore has no lookup tables.
- There are no PostgreSQL native enums and no Prisma `enum` declarations, and an integration test asserts that none exist. A future categorical column uses a text-primary-key lookup table (`value`, optional `description`, timestamps) with a foreign key and values inserted by migrations, not a native enum.

### Money and coordinates

- Monetary amounts are `NUMERIC(12,2)`; the discount rate is `NUMERIC(3,2)` constrained to 0 through 1, enough for every PRD tier (0.00, 0.05, 0.10, 0.15, 0.20). PostgreSQL rounds a rate with more than two decimal places to the column scale instead of rejecting it, so a finer tier (such as 12.5%) needs a migration widening the scale first. Amounts are nonnegative. Values outside `NUMERIC(12,2)`, such as `10000000000.00`, fail with a numeric overflow rather than being stored.
- Mappings convert Prisma `Decimal` values to fixed two-decimal strings (`"150.00"`) using the decimal value itself, never a JavaScript number. They refuse non-finite values or values with more decimal places than the column scale instead of rounding. Write amounts to Prisma as decimal strings.
- Coordinates are `double precision`, which matches JavaScript number fidelity without decimal rounding. CHECKs bound warehouse and destination latitude to -90 through 90 and longitude to -180 through 180 (inclusive); `NaN` and infinities fail these checks.

### Outcomes and retention

- The schema stores application outcomes and snapshots, never HTTP status codes or response envelopes. The HTTP adapter maps outcomes to responses.
- Only accepted Orders are stored, and they are kept indefinitely. Cleanup is future work. A business rejection (insufficient stock or excessive shipping) is computed, returned, and forgotten, so there is no rejection history and a rejected request consumes no `submission_key`.
- Every foreign key uses `ON DELETE RESTRICT ON UPDATE RESTRICT`. Deleting or re-keying a warehouse or Order that an allocation still references fails; nothing cascades.
- The schema does not enforce that an Order's allocations sum to its quantity, or that allocations never exceed warehouse stock. These cross-row invariants belong to the SubmitOrder transaction.

### Write pattern for submission (#10)

Within one transaction, SubmitOrder locks the warehouse rows in ascending `id` order, recomputes the outcome from the locked stock, and, on acceptance, inserts the Order and its allocations and decrements stock before committing. A rejection is returned to the caller; nothing is written.

The `submission_key` is the duplicate-request guard. After the warehouse rows are locked, SubmitOrder looks up the Order for that key: if one exists with the same quantity and destination, it is returned as-is and stock is untouched; if the stored request differs, the attempt is a conflict. Otherwise the transaction proceeds, with `customer_order_submission_key_key` as the backstop against a concurrent attempt (unique violation `23505`). Because rejections are not stored, a rejected request leaves its key unused and a retry is evaluated fresh.

Issue #10's tests must cover allocations summing to the requested quantity and stock never going negative, which the schema does not enforce.

### Timestamps

All three application tables follow [ADR 0003](adr/0003-database-managed-timestamps.md):

- `created_at` and `updated_at` are `timestamptz NOT NULL DEFAULT NOW()`.
- The migration installs `public.update_timestamp()` with `CREATE OR REPLACE`, and each table has a `BEFORE UPDATE ... FOR EACH ROW` trigger named `update_<table>_updated_at`, recreated after `DROP TRIGGER IF EXISTS`.
- The Prisma schema declares both columns as `@default(dbgenerated())`. With `@default(now())`, Prisma sends its own clock value on insert instead of letting PostgreSQL apply the transaction time. `@default(dbgenerated("now()"))` would be reported as drift against the migrated `now()` default. `@default(dbgenerated())` makes Prisma omit both columns, and the migration supplies the default. There is no `@updatedAt`.

## Prisma client and connection pooling

- The Prisma 7 client is generated into `packages/persistence/src/generated/prisma`. It is gitignored and excluded from lint, formatting, and coverage. The Turbo `generate` task runs `prisma generate` before `build` and `typecheck`, so a clean checkout builds without a committed client or a database connection.
- `createPrismaClient(pool)` builds the client with `new PrismaPg(pool)` over the pool returned by `createDatabasePool`. There is no second pool. The caller owns the pool: call `prisma.$disconnect()`, then `pool.end()`.
- `prisma.config.ts` reads `DATABASE_URL` from the environment. Prisma 7 does not load `.env` files.

## Commands

Run from the repository root with `DATABASE_URL` set to the target database. `./dev.sh` runs `db:seed` automatically for the worktree database.

| Command                                                         | Effect                                                                                         |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `corepack pnpm db:migrate`                                      | Apply pending migrations (`prisma migrate deploy`)                                             |
| `corepack pnpm db:seed`                                         | Apply pending migrations, then insert missing seed warehouses. Existing rows are never changed |
| `SCOS_CONFIRM_DATABASE_RESET=<database> corepack pnpm db:reset` | Destructive: drop all data, reapply migrations, then seed                                      |

The seed uses `INSERT ... ON CONFLICT (id) DO NOTHING`. Rerunning it never replenishes consumed stock or overwrites existing warehouses. If a warehouse name exists under a different ID, the seed fails instead of overwriting it.

`db:reset` refuses to run unless `SCOS_CONFIRM_DATABASE_RESET` exactly matches the database name in `DATABASE_URL`. It then runs `prisma migrate reset --force` and the seed. Use it only for disposable development or test databases. A person runs it: Prisma 7 blocks `prisma migrate reset` when it detects an AI coding agent unless the user explicitly consents.

## Verification

`corepack pnpm test:integration` (with `DATABASE_TEST_URL` set) runs `packages/persistence/test/*.integration.test.ts` against real PostgreSQL. Each test file creates a uniquely named database next to `scos_test` on the disposable test server, applies the migrations with `prisma migrate deploy`, and drops the database afterwards. The tests cover clean migration and drift, timestamp columns and triggers on every table, timestamp behavior through Prisma and raw SQL, UUIDv7 defaults, constraints and restricted deletes, decimal round-trips, and seed reruns.
