# @scos/api

The Hono HTTP adapter for SCOS Ordering. It validates requests, calls the core
use cases (`VerifyOrder`, `SubmitOrder`), and maps their typed outcomes to HTTP
responses. Business rules live in `packages/core`; SQL lives in
`packages/persistence`.

## Reading order

Start at a runtime's entry point and follow the wiring inward:

1. **Entry point** (`src/entrypoints/node.ts`): validates the environment,
   starts telemetry, calls the composition, listens, and shuts down on
   SIGINT/SIGTERM. The Cloudflare Worker's entry point is
   `src/entrypoints/worker.ts`: its `fetch` handler validates `env` once per
   isolate, builds telemetry and the composition, and hands the telemetry
   flush to `ctx.waitUntil`. Future runtimes add `entrypoints/lambda*.ts`
   (#14, deferred).
2. **Composition root** (`src/composition/node.ts`): opens the database
   (`composition/database.ts`), builds the persistence adapters and use cases,
   wraps them in the telemetry decorators, and calls `createApp`. It returns
   `{ app, close }`. The Worker's (`src/composition/worker.ts`) builds the
   same app once per isolate and opens a pool and Prisma client over the
   Hyperdrive binding per request (see [Cloudflare Worker](#cloudflare-worker)).
3. **App** (`src/app.ts`): `createApp` mounts the endpoint apps. It only takes
   use cases that already exist; it opens nothing and reads no environment.
4. **Endpoints** (`src/endpoints/<name>/`): each one's contract (Zod schemas),
   app (routes and outcome-to-HTTP mapping) and its own composition.
5. **Core and persistence**: the use cases and ports are in `packages/core`,
   and the adapters that implement those ports are in `packages/persistence`.

```text
src/
  entrypoints/
    node.ts        local Node.js server: validate config, start telemetry,
                   listen, graceful shutdown (one file per runtime)
    worker.ts      Cloudflare Worker fetch handler: validate env once per
                   isolate, compose, flush telemetry under ctx.waitUntil
    worker.unused-module.ts
                   stub the Worker bundle aliases unused optional modules to
  composition/
    node.ts        composeApplication: all routes over one pool (Node/Lambda)
    worker.ts      composeWorkerApplication: all routes, a pool and Prisma
                   client per request over Hyperdrive (Workers)
    database.ts    bounded pool + Prisma shared by the database compositions
    composed-application.ts
                   the { app, close } type every runtime composition returns
  endpoints/
    health/        contract, app, composition, config (+ tests)
    verify-order/  contract, examples, app, composition (+ tests)
    submit-order/  contract, examples, app, composition, messages, serializers (+ tests)
  http/            shared only: error envelope and codes, messages, JSON guard and
                   validator hook, createEndpointApp, shared schemas, estimate shape,
                   the example scenarios shared by verify and submit,
                   describe-route (a contract as hono-openapi route documentation),
                   and the Logger port and its console JSON default
  telemetry/       runtime-neutral telemetry: config schema, Telemetry port, log
                   record contract, HTTP middleware
    decorators/    tracing decorators, one file per wrapped use case or port
    node/          Node/Lambda only: OpenTelemetry SDK, exporters, Pino adapter
    workers/       Workers only: OpenTelemetry SDK with per-request fetch export,
                   AsyncLocalStorage context manager, console.log sink
  openapi/         hono-openapi document options, offline generation and export,
                   /openapi.json and /docs routes (+ tests)
  app.ts           createApp: mounts the three endpoint apps and the docs routes
  config.ts        shared env parsing, DATABASE_URL config, local-server config
  routes.ts        the route/status table assembled from the endpoint contracts
  index.ts         public exports
  testing/         unit-test support (fixtures, request cases, spies, black hole,
                   seeded in-memory use cases, Ajv over the generated document)
scripts/openapi.ts CLI for `openapi:export`; the build bundles and runs it too
test/workers/      the Worker in workerd against PostgreSQL (integration)
wrangler.jsonc     the Worker: nodejs_compat, compatibility date, Hyperdrive,
                   observability, non-secret vars
```

Each endpoint folder owns its request and response schemas, route contract,
app factory, composition and tests. Dependencies point one way: an endpoint
may import `src/http/` and the shared `config.ts` and `composition/database.ts`; `http/`
never imports an endpoint, and endpoints never import each other. The Order
Estimate shape and serializer are in `http/estimate.ts` because both
verification (200) and a rejected submission (422) return it.

The app factories and contracts (`endpoints/*/contract.ts`, `routes.ts`) read
no environment and open no connection, so tests and the offline OpenAPI export
can import them without deployment configuration. See
[OpenAPI and documentation](#openapi-and-documentation).

## Per-endpoint apps and compositions

Each endpoint is a separately constructible Hono app, so each can be deployed
as its own Lambda function (#14, deferred). The Cloudflare Worker (#28), which
is the first hosted target, serves the combined app instead. The per-endpoint
apps are:

| Route                        | App factory                                      | Composition                              | Builds                         | Configuration              |
| ---------------------------- | ------------------------------------------------ | ---------------------------------------- | ------------------------------ | -------------------------- |
| `GET /health`                | `createHealthApp({ logger? })`                   | `composeHealthApplication(options?)`     | nothing                        | telemetry only             |
| `POST /api/v1/orders/verify` | `createVerifyOrderApp({ verifyOrder, logger? })` | `composeVerifyOrderApplication(options)` | pool, Prisma, inventory reader | `DATABASE_URL` + telemetry |
| `POST /api/v1/orders`        | `createSubmitOrderApp({ submitOrder, logger? })` | `composeSubmitOrderApplication(options)` | pool, Prisma, submission store | `DATABASE_URL` + telemetry |

- Every standalone app is complete: the same Content-Type and JSON handling,
  error envelope and 500 mapping (with its route's message), and the same
  `404 NOT_FOUND` envelope for every other method or path. They share this
  through one helper, `createEndpointApp` in `src/http/endpoint-app.ts`, and
  tests check that each standalone app returns the same status,
  `Content-Type`, `Retry-After` and body as the combined app.
- Each composition returns `{ app, close }`. The submit composition also takes
  the submission store options, `maxSubmissionAttempts`, and
  `decorateSubmissionStore`, which the tests use for failure injection.
- `createApp({ verifyOrder, submitOrder, logger? })` mounts the three with
  Hono's `app.route()`. Each mounted app keeps its own error handler for its
  route, and the combined app answers everything else with the same 404
  envelope, so its behaviour is identical to the standalone apps.
  `createApp` also serves the documentation routes (`GET /openapi.json`,
  `GET /docs`); the standalone apps do not. `composeApplication` builds it
  over one pool for the local server (`src/entrypoints/node.ts`).
- Configuration is validated per runtime: `parseHealthConfig` requires
  nothing, `parseDatabaseConfig` (for the verify and submit runtimes) requires
  `DATABASE_URL`, and the local server (`parseConfig`) requires `DATABASE_URL`
  and accepts `PORT`. All of them validate the optional telemetry variables
  ([Telemetry](#telemetry)).
- Every composition accepts `telemetry` (a `Telemetry` object) and `logger`.
  With `telemetry`, it wraps the app in the HTTP server middleware once and
  decorates its use cases and persistence ports with spans; without it,
  nothing is instrumented. `createApp` and the endpoint app factories never
  add the middleware themselves, so each request gets exactly one server span.
- `src/index.ts` exports the app factories, the compositions, these
  configuration parsers, the route contract (`routes`, `API_PREFIX`), the
  request/response schemas, and the OpenAPI functions: `generateOpenApiDocument(app)`
  and `serializeOpenApiDocument(document)`, plus the offline `buildOpenApiDocument()`
  and `renderOpenApiDocument()` (all generation is async), and `OPENAPI_PATH` and
  `DOCS_PATH`. `routes[*].servedBy` names the app that serves each route.

### Notes for Lambda deployment (#14, deferred)

The AWS Lambda deployment follows the Cloudflare one. These notes stay valid
for when it resumes.

- **Telemetry:** call `startTelemetry` once in module scope, pass its
  `logger` and `telemetry` to the composition, and call
  `await runtime.forceFlush(timeoutMs)` at the end of every invocation. Never rely
  on process shutdown. The bundle loads `pino` from `node_modules` at runtime,
  so the artifact must include it. See
  [docs/observability.md](../../docs/observability.md#initialization-graceful-shutdown-and-lambda-lifecycle).

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

## Cloudflare Worker

The same API runs as a Cloudflare Worker (`wrangler.jsonc`). It is the first
hosted target, reaching PlanetScale Postgres through Hyperdrive; the AWS Lambda
deployment is deferred
([ADR 0005](../../docs/adr/0005-cloudflare-first-deployment.md)). The Hyperdrive
design is #28, the deployment pipeline is #15, and the hosted demonstration is
#33; this package holds the runtime and runs it locally without a Cloudflare
account.

- `src/entrypoints/worker.ts` validates the Worker's `env` once per isolate
  with `parseWorkerConfig`: the telemetry variables, and `DATABASE_URL` taken
  from the `HYPERDRIVE` binding's connection string. Invalid configuration
  serves nothing (every request gets `500 INTERNAL_ERROR`) and logs sanitized
  `NAME: reason` lines once.
- `src/composition/worker.ts` serves `createApp` (the three endpoints and the
  docs). Each request that reaches a use case gets its own pg pool (at most
  two connections) and Prisma client over the Hyperdrive connection string,
  closed under `ctx.waitUntil` after the response, as #28 and Cloudflare's
  Hyperdrive connection-lifecycle guidance require; nothing is shared across
  requests.
- `@scos/persistence` resolves to its `workerd` build there: the same adapters
  over a Prisma client generated with `runtime = "workerd"`.
- Telemetry: `src/telemetry/workers/` (see
  [docs/observability.md](../../docs/observability.md#cloudflare-workers-runtime)).
- Hosted, Hyperdrive pools in transaction mode and resets a connection when
  it returns to the pool. The submission transaction's
  `set_config(..., true)` timeouts are transaction-local, so they should carry
  over; #28 verifies that, and that nothing relies on session state.
  Hyperdrive query caching stays disabled, so inventory reads are never stale.

```sh
./dev.sh             # once: database, migrations, seed (then Ctrl+C)
export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgresql://scos:scos@127.0.0.1:5432/<database>
pnpm --filter @scos/persistence build
pnpm --filter @scos/api dev:worker        # wrangler dev, http://localhost:8787
```

Without the variable, `wrangler dev` uses `localConnectionString` in
`wrangler.jsonc` (`postgresql://scos:scos@localhost:5432/scos`). Local
variables and secrets go in `apps/api/.dev.vars` (see `.dev.vars.example`).

## Endpoints

The order endpoints are versioned under `/api/v1` (`API_PREFIX`, exported with
the route contract). `GET /health` stays at the root: it is a liveness probe
outside the API surface. Each standalone endpoint app serves its full prefixed
path itself. The unprefixed paths (`/orders`, `/orders/verify`) and `/api/...`
without the version are neither aliases nor redirects: they return the standard
`404 NOT_FOUND` envelope.

All request and response bodies are JSON. Money is a decimal string with two
fractional digits (`"150.00"`); `discountRate` is a two-decimal string
(`"0.05"`). `distanceKm` is an unrounded number.

### `GET /health`

`200 {"status":"ok"}`. It never touches the database, so it answers while
PostgreSQL is unavailable.

### `POST /api/v1/orders/verify`

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

### `POST /api/v1/orders`

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

Requests are validated with Zod through hono-openapi's `validator`, which wraps
`sValidator` from `@hono/standard-validator` unchanged, before any use case
runs. A malformed request is
`400 INVALID_REQUEST`; it stores nothing and consumes no `submissionId`.

| Field          | Rule                                                                                                                                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quantity`     | JSON integer, 1 to 66,666,666 (`MAX_QUANTITY` in core: the largest subtotal that fits `NUMERIC(12, 2)`)                                                                                               |
| `latitude`     | JSON number, -90 to 90 inclusive                                                                                                                                                                      |
| `longitude`    | JSON number, -180 to 180 inclusive                                                                                                                                                                    |
| `submissionId` | JSON string, 1 to 255 characters (Unicode code points), no leading or trailing whitespace (so blank, tab- or newline-only keys fail), no NUL, well-formed Unicode; any string, not necessarily a UUID |

- **Content type:** the body must be sent with `Content-Type: application/json`
  (parameters such as `charset` and `+json` media types are accepted). A missing
  or different content type is `400`, as is malformed JSON or an empty body.
- **Unknown fields** are rejected (`400`), including `submissionId` on
  `/api/v1/orders/verify`.
- **No coercion:** `"10"` is not a quantity; strings are never converted to
  numbers.
- The limits come from `@scos/core` (`quantitySchema`, `submissionKeySchema`,
  `LATITUDE_LIMIT`, `LONGITUDE_LIMIT`), and tests check they match.

## Errors

Every non-2xx body has an `error` object. It is exactly this envelope, except
that a `422` submission rejection also carries the `estimate` that caused it:

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

| Status | Code                     | When                                                                                                              |
| ------ | ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| 400    | `INVALID_REQUEST`        | Malformed JSON, wrong or missing content type, unknown field, value outside the limits                            |
| 404    | `NOT_FOUND`              | Unknown path or method                                                                                            |
| 409    | `SUBMISSION_ID_CONFLICT` | `submissionId` belongs to an Order with different inputs; nothing about it is revealed                            |
| 422    | `INSUFFICIENT_STOCK`     | Not enough total stock (body includes `estimate`); nothing stored                                                 |
| 422    | `SHIPPING_EXCEEDS_LIMIT` | Shipping above 15% of the discounted merchandise total (body includes `estimate`)                                 |
| 500    | `INTERNAL_ERROR`         | Unexpected server error; logged server-side, no internals in the response                                         |
| 503    | `SERVICE_UNAVAILABLE`    | `POST /api/v1/orders` only: contention through every attempt, or no database connection in time; `Retry-After: 1` |

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
`POST /api/v1/orders` with the same `submissionId` and the same body**: if an earlier
attempt was committed, the original Order is returned (`201`) and stock is not
deducted again; otherwise the request is evaluated afresh. Use a new
`submissionId` only for a new order.

## OpenAPI and documentation

The OpenAPI 3.1 document is generated by
[hono-openapi](https://hono.dev/examples/hono-openapi) from the Hono app, not
written by hand. Each endpoint app attaches its route contract to its route
with `describeRoute` (`http/describe-route.ts`): summary, description, the
request body and every response through hono-openapi's `resolver`, the named
examples and the `Retry-After` header. The request body is validated with
hono-openapi's `validator`, so the documented and the enforced schema are the
same object. hono-openapi converts the Zod schemas with Zod's own
`z.toJSONSchema` (draft 2020-12, the OpenAPI 3.1 dialect): request bodies as
input, responses as output (`resolver(schema, { options: { io: "output" } })`).
A schema's `.meta({ id, description })` publishes it under that name in
`components.schemas` with its description. `src/openapi/document.ts` holds only
the document-level options (`info`, relative `servers`, `tags`, the reusable
`components.responses.NotFound`, the excluded documentation routes, and no
default validation error, since every route documents its own 400). Each
endpoint's named request and response examples live next to its contract
(`endpoints/*/examples.ts`, `http/estimate-examples.ts`).

| Route               | Served by   | Content                                                            |
| ------------------- | ----------- | ------------------------------------------------------------------ |
| `GET /openapi.json` | `createApp` | The document, byte-identical to the build's `dist/openapi.json`    |
| `GET /docs`         | `createApp` | Swagger UI over `/openapi.json`; "Try it out" hits the same origin |

Neither route is listed in the document, and the per-endpoint (Lambda) apps do
not serve them. hono-openapi generates the served document at runtime, once, on
the first request to `/openapi.json`, from the combined app; the offline export
(`src/openapi/offline.ts`) generates it the same way from `createApp` over stub
use cases. Swagger UI's scripts and styles load from the jsDelivr CDN, pinned
to one swagger-ui-dist release (`SWAGGER_UI_VERSION`), so
the browser viewing `/docs` needs internet access. The request examples produce
the documented responses against a freshly seeded database (send the repeat and
conflict examples after the acceptance example); after other orders, stock and
therefore amounts can differ.

The specification is a build artifact, not a committed file. The route
contracts and their Zod schemas are the single source of truth: the same
schemas validate requests and generate the document. A committed copy would
be a second source that can drift from them, so the document is always
generated, never stored. `pnpm build`
writes `apps/api/dist/openapi.json` after bundling the server: `build.mjs`
bundles the exporter CLI (`scripts/openapi.ts`) with the server's esbuild
settings to a temporary file outside `dist/`, and runs it with Node.js without
`DATABASE_URL`. It needs no server, environment or database, and none of it is
added to `dist/node.js`. `dist/` is ignored by Git and is a Turbo output of
`build`. To write it on demand:

```sh
pnpm openapi:export                                   # apps/api/dist/openapi.json (Turbo builds core first)
pnpm --filter @scos/api openapi:export out.json       # another path, relative to apps/api
```

The package script runs the CLI with tsx and expects `@scos/core` to be built.
The output is `JSON.stringify(document, null, 2)` plus a newline, with no
timestamps; key and component order follow route registration, which is fixed,
so two builds produce identical bytes. Unit tests check that the export is
exactly what `GET /openapi.json` serves and that two renders are identical.

**What JSON Schema cannot express.** The `SubmissionId` component documents
these server-side rules in prose; they are the only differences between the
published request schemas and runtime validation, and unit tests check both
directions (Ajv on the generated schema, Zod, and the app):

- no leading or trailing whitespace (the key is never trimmed);
- no NUL character (U+0000);
- well-formed Unicode (no lone surrogates).

The Content-Type requirement, rejection of unknown fields (also expressed as
`additionalProperties: false`) and the absence of coercion are stated in each
request body's description. Unit tests also check that every example parses
with its Zod schema, validates with Ajv against the generated JSON Schema, and
equals, byte for byte, the response the app returns when the paired request is
replayed through the real `VerifyOrder`/`SubmitOrder` use cases over the seed
inventory; and that the document passes `@apidevtools/swagger-parser`.

## Configuration

`src/entrypoints/node.ts` validates the environment once, before starting telemetry,
building any database client or listening. On failure it prints only the
variable name and a reason to stderr (never the value) and exits with
status 1.

| Variable       | Required | Rule                                                                   |
| -------------- | -------- | ---------------------------------------------------------------------- |
| `DATABASE_URL` | Yes      | `postgres://` or `postgresql://` URL with a host                       |
| `PORT`         | No       | Integer 0-65535, default 3000 when unset; an empty `PORT=` is rejected |

Validation does not connect to the database: the server starts and `/health`
answers while PostgreSQL is down. SIGINT or SIGTERM closes the listener
(in-flight requests finish first; see the limitation below), disconnects
Prisma, ends the pool, and then flushes and stops telemetry (at most 5 s).

### Telemetry

Logs are Pino JSON lines on stdout. Traces and metrics are off by default
(`OTEL_TRACES_EXPORTER=none`, `OTEL_METRICS_EXPORTER=none`) and can be sent
over OTLP/HTTP or printed with `console`. The main variables:

| Variable                                                         | Default                              | Purpose                                         |
| ---------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------- |
| `LOG_LEVEL`                                                      | `info`                               | `trace` ... `fatal`, or `silent`                |
| `OTEL_TRACES_EXPORTER` / `OTEL_METRICS_EXPORTER`                 | `none`                               | `otlp`, `console` or `none`                     |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                                    | `http://localhost:4318`              | Collector base URL (validated only when used)   |
| `OTEL_TRACES_SAMPLER_ARG`                                        | `1`                                  | Ratio of new root traces sampled (parent-based) |
| `OTEL_SERVICE_NAME`, `SERVICE_VERSION`, `DEPLOYMENT_ENVIRONMENT` | `scos-api`, package version, `local` | Resource attributes on every signal             |
| `OTEL_SDK_DISABLED`                                              | `false`                              | `true` turns tracing and metrics off            |

The full table, the spans and metrics, the log field mapping, sampling,
export bounds, failure behaviour and sample output are in
[docs/observability.md](../../docs/observability.md).

### Database timeouts

| Limit                                           | Value       | Applies to                                  |
| ----------------------------------------------- | ----------- | ------------------------------------------- |
| pg `connectionTimeoutMillis`                    | 5 s         | acquiring or opening a pooled connection    |
| Prisma `maxWait` / `timeout`                    | 5 s / 15 s  | starting / running a submission transaction |
| PostgreSQL `lock_timeout` / `statement_timeout` | 10 s / 15 s | statements inside a submission transaction  |

The connection timeout fires before any statement is sent on that
connection, so it is always safe to retry: on `POST /api/v1/orders` it becomes `503`.
There is deliberately **no client-side query timeout** (pg `query_timeout`).
When it fires, pg stops waiting but neither cancels the statement nor closes
the connection. A queued `ROLLBACK` can then be dropped unsent, and the
connection goes back to the pool with its transaction still open, where a
retry could read that transaction's uncommitted Order. Statements are bounded
on the server instead.

What the client sees when the database fails:

- `POST /api/v1/orders`: no connection in time (every pooled connection busy, or the
  server unreachable or silent while connecting) is `503 SERVICE_UNAVAILABLE`
  with `Retry-After`. A refused connection or any other unexpected error is
  `500 INTERNAL_ERROR`. Either way, retry with the same `submissionId`.
- `POST /api/v1/orders/verify`: any database failure, including a connection timeout,
  is `500 INTERNAL_ERROR`. Verification stores nothing, so it is always safe to
  retry.
- `GET /health`: unaffected.

Worst-case latency with a live but overloaded server: `POST /api/v1/orders` waits up
to 5 s for the unlocked lookup's connection, then up to 3 transaction attempts
of 5 s (connection) + 15 s (transaction) each, about 65 s before `503`.
`POST /api/v1/orders/verify` waits up to 5 s for a connection. The verification read
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
pnpm db:seed        # migrate and seed warehouses
pnpm api:dev        # watch mode (or ./dev.sh, which sets DATABASE_URL)
pnpm api:start      # built bundle
```

## Tests

```sh
# Unit tests (no database): contracts, handlers with fake use cases, config,
# composition, telemetry with in-memory exporters and captured logs, the
# entrypoint spawned as a subprocess, the built dist/node.js (log
# correlation on the bundled load path; build first, as `pnpm test` does), and
# the OpenAPI document (validity, examples, schema/runtime agreement, export
# equals the served bytes).
pnpm --filter @scos/api test

# The Worker inside workerd (@cloudflare/vitest-pool-workers), no database:
# both telemetry contract suites, OTLP export over fetch, the fetch handler
# and the composition. Part of the root `pnpm test`.
pnpm --filter @scos/api test:workers

# Full-stack tests through the composed app against real PostgreSQL, then the
# Worker in workerd against PostgreSQL through its Hyperdrive binding.
DATABASE_TEST_URL=postgresql://scos_test:scos_test@localhost:5433/scos_test \
  pnpm exec turbo run test:integration --filter=@scos/api
```

The integration tests (`test/*.integration.test.ts`) create an isolated,
migrated and seeded database per file beside `scos_test` and drop it
afterwards. They fail, rather than skip, when `DATABASE_TEST_URL` is missing
or does not name `scos_test`. They cover the per-endpoint verify and submit compositions over separate pools, verification leaving every row
unchanged, acceptance and both rejections, repeats after stock changes and a
restart, conflicts, concurrent submissions under controlled lock overlap, and
failure injection (rollback at each stage, `submission_key` unique violations,
real `lock_timeout` retries ending in `503`, and a lost response after commit),
and the persistence decorator spans and submission counter against the real
database, including an unreachable collector.

The OpenAPI integration test also compares the served `/openapi.json` with the
build artifact `dist/openapi.json`, so run it through turbo (which builds
first) or after `pnpm build`.
