# @scos/api

The Hono HTTP adapter for SCOS Ordering. It validates requests, calls the core
use cases (`VerifyOrder`, `SubmitOrder`), and maps their typed outcomes to HTTP
responses. Business rules live in `packages/core`; SQL lives in
`packages/persistence`.

| File                    | Role                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `src/http/contracts.ts` | Zod request/response schemas, error codes, and the route/status table (`servedBy`)  |
| `src/app.ts`            | One Hono app per endpoint, plus `createApp`, which mounts all three                 |
| `src/composition.ts`    | Composition roots per endpoint and combined: pool, Prisma, adapters, use cases, app |
| `src/config.ts`         | Environment schemas per runtime (health, database endpoints, local server)          |
| `src/server.ts`         | Node.js entrypoint: validate config, listen, graceful shutdown                      |

The app factories and `src/http/contracts.ts` read no environment and open no
connection, so tests and an offline OpenAPI export (#12) can import them
without deployment configuration. The schemas convert with
`z.toJSONSchema(schema, { target: "draft-07" })`; the submissionId refinements
(no surrounding whitespace, no NUL, well-formed Unicode) are not expressible in
JSON Schema and must be documented in prose.

## Per-endpoint apps and compositions

Each endpoint is a separately constructible Hono app, so each can be deployed
as its own Lambda function (#14):

| Route                 | App factory                                      | Composition                              | Builds                         | Configuration  |
| --------------------- | ------------------------------------------------ | ---------------------------------------- | ------------------------------ | -------------- |
| `GET /health`         | `createHealthApp({ logger? })`                   | `composeHealthApplication()`             | nothing                        | none           |
| `POST /orders/verify` | `createVerifyOrderApp({ verifyOrder, logger? })` | `composeVerifyOrderApplication(options)` | pool, Prisma, inventory reader | `DATABASE_URL` |
| `POST /orders`        | `createSubmitOrderApp({ submitOrder, logger? })` | `composeSubmitOrderApplication(options)` | pool, Prisma, submission store | `DATABASE_URL` |

- Every standalone app is complete: the same Content-Type and JSON handling,
  error envelope and 500 mapping (with its route's message), and the same
  `404 NOT_FOUND` envelope for every other method or path. They share this
  through one helper in `src/app.ts`, and tests check that each standalone app
  returns the same status, `Content-Type`, `Retry-After` and body as the
  combined app.
- Each composition returns `{ app, close }`. The submit composition also takes
  the submission store options, `maxSubmissionAttempts`, and
  `decorateSubmissionStore`, which the tests use for failure injection.
- `createApp({ verifyOrder, submitOrder, logger? })` mounts the three with
  Hono's `app.route()`. Each mounted app keeps its own error handler for its
  route, and the combined app answers everything else with the same 404
  envelope, so its behaviour is identical to the standalone apps.
  `composeApplication` builds it over one pool for the local server
  (`src/server.ts`) and for the documentation routes (#12).
- Configuration is validated per runtime: `parseHealthConfig` requires
  nothing, `parseDatabaseConfig` requires `DATABASE_URL`, and the local server
  (`parseConfig`) requires `DATABASE_URL` and accepts `PORT`.
- Everything above is exported from `src/index.ts`, and `routes[*].servedBy`
  in the contract names the app that serves each route.

### Notes for Lambda deployment (#14)

- The in-process pg pool belongs to one Lambda execution environment. An
  environment serves one request at a time, so the pool never shares
  connections across environments. Nothing sets the pool size yet (pg
  defaults to 10); the recommendation is for #14 to apply and verify `max: 1`
  per Lambda environment.
- The connection approach is **RDS Proxy**. It pools connections across all
  per-endpoint functions and bounds the connections that reach PostgreSQL.
- Open checks for #14 (not yet verified):
  - Connection pinning with this stack. The submission transaction runs
    `set_config('lock_timeout' | 'statement_timeout', ..., true)`. Check
    whether that pins the client connection, and whether pg/Prisma prepared
    statements do.
  - IAM or Secrets Manager authentication for RDS Proxy.
  - RDS Proxy timeouts (connection borrow and idle client timeouts) versus
    our 5 s connect timeout (`connectionTimeoutMillis`).

## Endpoints

All request and response bodies are JSON. Money is a decimal string with two
fractional digits (`"150.00"`); `discountRate` is a two-decimal string
(`"0.05"`). `distanceKm` is an unrounded number.

### `GET /health`

`200 {"status":"ok"}`. It never touches the database, so it answers while
PostgreSQL is unavailable.

### `POST /orders/verify`

An advisory Order Estimate against current stock. It reserves and stores
nothing, and does not promise that a later submission is accepted.

```json
{ "quantity": 30, "latitude": 49.0097, "longitude": 2.5478 }
```

`200` for every well-formed request, valid or not:

```json
{
  "valid": true,
  "reason": null,
  "quantity": 30,
  "destination": { "latitude": 49.0097, "longitude": 2.5478 },
  "merchandiseSubtotal": "4500.00",
  "discountRate": "0.05",
  "discountAmount": "225.00",
  "discountedMerchandiseTotal": "4275.00",
  "shippingCost": "0.00",
  "orderTotal": "4275.00",
  "allocations": [
    {
      "warehouseId": "01996000-0000-7000-8000-000000000004",
      "quantity": 30,
      "distanceKm": 0.0029255906921376654
    }
  ]
}
```

- `valid: false, reason: "SHIPPING_EXCEEDS_LIMIT"` keeps every amount and
  allocation.
- `valid: false, reason: "INSUFFICIENT_STOCK"` keeps the merchandise and
  discount amounts, with `shippingCost: null`, `orderTotal: null` and
  `allocations: []`.

### `POST /orders`

Submits an Order against current stock. `submissionId` is a client-generated
key that makes retries safe ([ADR 0004](../../docs/adr/0004-deduplicate-accepted-orders.md));
no `Idempotency-Key` header is used.

```json
{ "submissionId": "3f0c7d9e-order-1", "quantity": 30, "latitude": 49.0097, "longitude": 2.5478 }
```

`201` with the accepted Order:

```json
{
  "orderNumber": "SO-7K2M9Q4XBV1D",
  "submissionId": "3f0c7d9e-order-1",
  "quantity": 30,
  "destination": { "latitude": 49.0097, "longitude": 2.5478 },
  "unitPrice": "150.00",
  "merchandiseSubtotal": "4500.00",
  "discountRate": "0.05",
  "discountAmount": "225.00",
  "discountedMerchandiseTotal": "4275.00",
  "shippingCost": "0.00",
  "orderTotal": "4275.00",
  "allocations": [{ "warehouseId": "01996000-0000-7000-8000-000000000004", "quantity": 30 }]
}
```

Repeating a `submissionId` with the same quantity and destination returns the
original Order (`201`, byte-identical body) without deducting stock again,
even after stock changes or a restart. Reusing it with a different quantity or
destination is `409`. Business rejections (`422`) are not stored, so the same
`submissionId` is re-evaluated when repeated and may later succeed.

`422` body: the error plus the estimate that caused it, in the same shape as a
`valid: false` verification:

```json
{
  "error": { "code": "INSUFFICIENT_STOCK", "message": "..." },
  "estimate": { "valid": false, "reason": "INSUFFICIENT_STOCK", "shippingCost": null, "...": "..." }
}
```

## Request validation

Requests are validated with Zod through `sValidator` from
`@hono/standard-validator` before any use case runs. A malformed request is
`400 INVALID_REQUEST`; it stores nothing and consumes no `submissionId`.

| Field          | Rule                                                                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quantity`     | JSON integer, 1 to 66,666,666 (`MAX_QUANTITY` in core: the largest subtotal that fits `NUMERIC(12, 2)`)                                            |
| `latitude`     | JSON number, -90 to 90 inclusive                                                                                                                   |
| `longitude`    | JSON number, -180 to 180 inclusive                                                                                                                 |
| `submissionId` | JSON string, 1 to 255 UTF-16 code units, no leading or trailing whitespace (so blank, tab- or newline-only keys fail), no NUL, well-formed Unicode |

- **Content type:** the body must be sent with `Content-Type: application/json`
  (parameters such as `charset` and `+json` media types are accepted). A missing
  or different content type is `400`, as is malformed JSON or an empty body.
- **Unknown fields** are rejected (`400`), including `submissionId` on
  `/orders/verify`.
- **No coercion:** `"10"` is not a quantity; strings are never converted to
  numbers.
- The limits come from `@scos/core` (`quantitySchema`, `submissionKeySchema`,
  `LATITUDE_LIMIT`, `LONGITUDE_LIMIT`), and tests check they match.

## Errors

Every non-2xx response uses one envelope:

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "The request body is invalid.",
    "issues": [
      { "path": ["quantity"], "message": "Invalid input: expected number, received string" }
    ]
  }
}
```

`issues` is present only for schema failures; `path: []` refers to the body
itself (for example an unknown field).

| Status | Code                     | When                                                                                                       |
| ------ | ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 400    | `INVALID_REQUEST`        | Malformed JSON, wrong or missing content type, unknown field, value outside the limits                     |
| 404    | `NOT_FOUND`              | Unknown path or method                                                                                     |
| 409    | `SUBMISSION_ID_CONFLICT` | `submissionId` belongs to an Order with different inputs; nothing about it is revealed                     |
| 422    | `INSUFFICIENT_STOCK`     | Not enough total stock (body includes `estimate`); nothing stored                                          |
| 422    | `SHIPPING_EXCEEDS_LIMIT` | Shipping above 15% of the discounted merchandise total (body includes `estimate`)                          |
| 500    | `INTERNAL_ERROR`         | Unexpected server error; logged server-side, no internals in the response                                  |
| 503    | `SERVICE_UNAVAILABLE`    | `POST /orders` only: contention through every attempt, or no database connection in time; `Retry-After: 1` |

### Transient failures and retries

`SubmitOrder` retries transient database failures (serialization failure,
deadlock, lock or statement timeout, order-number collision, no connection
available in time) itself, up to `MAX_SUBMISSION_ATTEMPTS` (3) transactions per
request. When every attempt fails, or a lookup of the `submissionId` cannot get
a connection in time, the use case returns `unavailable` and the response is
`503 SERVICE_UNAVAILABLE` with `Retry-After`. Only failures known not to have
committed are treated this way, so a `503` means this request stored nothing
(a concurrent request with the same `submissionId` may still have stored its
Order; retrying returns it, or `409` if the body differs). See
[Database timeouts](#database-timeouts).

A `500` never means the order was accepted, but it does not guarantee that
nothing was stored either (for example a failed or lost `COMMIT`). After a
`500`, a `503`, a client timeout or a dropped connection, **retry
`POST /orders` with the same `submissionId` and the same body**: if an earlier
attempt was committed, the original Order is returned (`201`) and stock is not
deducted again; otherwise the request is evaluated afresh. Use a new
`submissionId` only for a new order.

## Configuration

`src/server.ts` validates the environment once, before building any database
client or listening. On failure it prints only the variable name and a reason
to stderr (never the value) and exits with status 1.

| Variable       | Required | Rule                                                                   |
| -------------- | -------- | ---------------------------------------------------------------------- |
| `DATABASE_URL` | Yes      | `postgres://` or `postgresql://` URL with a host                       |
| `PORT`         | No       | Integer 0-65535, default 3000 when unset; an empty `PORT=` is rejected |

Validation does not connect to the database: the server starts and `/health`
answers while PostgreSQL is down. SIGINT or SIGTERM closes the listener
(in-flight requests finish first; see the limitation below), disconnects
Prisma, and ends the pool.

### Database timeouts

| Limit                                           | Value       | Applies to                                  |
| ----------------------------------------------- | ----------- | ------------------------------------------- |
| pg `connectionTimeoutMillis`                    | 5 s         | acquiring or opening a pooled connection    |
| Prisma `maxWait` / `timeout`                    | 5 s / 15 s  | starting / running a submission transaction |
| PostgreSQL `lock_timeout` / `statement_timeout` | 10 s / 15 s | statements inside a submission transaction  |

The connection timeout fires before any statement is sent on that
connection, so it is always safe to retry: on `POST /orders` it becomes `503`.
There is deliberately **no client-side query timeout** (pg `query_timeout`).
When it fires, pg stops waiting but neither cancels the statement nor closes
the connection. A queued `ROLLBACK` can then be dropped unsent, and the
connection goes back to the pool with its transaction still open, where a
retry could read that transaction's uncommitted Order. Statements are bounded
on the server instead.

What the client sees when the database fails:

- `POST /orders`: no connection in time (every pooled connection busy, or the
  server unreachable or silent while connecting) is `503 SERVICE_UNAVAILABLE`
  with `Retry-After`. A refused connection or any other unexpected error is
  `500 INTERNAL_ERROR`. Either way, retry with the same `submissionId`.
- `POST /orders/verify`: any database failure, including a connection timeout,
  is `500 INTERNAL_ERROR`. Verification stores nothing, so it is always safe to
  retry.
- `GET /health`: unaffected.

Worst-case latency with a live but overloaded server: `POST /orders` waits up
to 5 s for the unlocked lookup's connection, then up to 3 transaction attempts
of 5 s (connection) + 15 s (transaction) each, about 65 s before `503`.
`POST /orders/verify` waits up to 5 s for a connection. The verification read
and the unlocked lookup run outside the submission transaction, so only the
database's default `statement_timeout` (none by default) bounds them; both are
single indexed or six-row reads.

**Known limitation:** if an already established connection goes silent (the
server or network stops answering mid-query without closing the socket), the
request waits until the operating system reports the connection broken, which
can take a long time with default TCP settings. Graceful shutdown waits for
that request too. A database that is unreachable or silent while connecting is
bounded by the 5 s connection timeout. TCP keepalive on the pool would bound
this without the risks of a client-side query timeout, but it is not
configured yet.

Submission transaction timeouts use the persistence defaults
(`DEFAULT_SUBMISSION_TRANSACTION_OPTIONS`); `composeApplication` accepts
overrides, and `connectionTimeoutMs` (a positive integer; pg treats 0 as no
limit), for tests.

## Running

```sh
export DATABASE_URL=postgresql://scos:scos@localhost:5432/scos
corepack pnpm db:seed        # migrate and seed warehouses
corepack pnpm api:dev        # watch mode (or ./dev.sh, which sets DATABASE_URL)
corepack pnpm api:start      # built bundle
```

## Tests

```sh
# Unit tests (no database): contracts, handlers with fake use cases, config,
# composition, and the entrypoint spawned as a subprocess.
corepack pnpm --filter @scos/api test

# Full-stack tests through the composed app against real PostgreSQL.
DATABASE_TEST_URL=postgresql://scos_test:scos_test@localhost:5433/scos_test \
  corepack pnpm exec turbo run test:integration --filter=@scos/api
```

The integration tests (`test/*.integration.test.ts`) create an isolated,
migrated and seeded database per file beside `scos_test` and drop it
afterwards. They fail, rather than skip, when `DATABASE_TEST_URL` is missing
or does not name `scos_test`. They cover the per-endpoint verify and submit compositions over separate pools, verification leaving every row
unchanged, acceptance and both rejections, repeats after stock changes and a
restart, conflicts, concurrent submissions under controlled lock overlap, and
failure injection (rollback at each stage, `submission_key` unique violations,
real `lock_timeout` retries ending in `503`, and a lost response after commit).
