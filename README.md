# SCOS Ordering

Backend for ordering SCOS Station P1 Pro devices. A Hono API verifies orders (`POST /api/v1/orders/verify`), accepts them idempotently by client `submissionId` (`POST /api/v1/orders`), and serves `GET /health`, the generated OpenAPI 3.1 specification at `GET /openapi.json`, and Swagger UI at `GET /docs`. Business rules live in a framework-independent core, and orders, allocations and warehouse stock are stored in PostgreSQL through Prisma. The API runs locally as a Node.js server and has a Cloudflare Worker entry point (`apps/api/src/entrypoints/worker.ts`), which is tested locally in workerd but not yet deployed (see [Limitations and next steps](#limitations-and-next-steps)).

New here? Follow the [evaluator walkthrough](#evaluator-walkthrough) from a fresh checkout.

## Prerequisites

- Node.js 24.15.0 (also pinned in `.node-version` and `.nvmrc`)
- pnpm (any recent version; it switches to the pinned version itself)
- Docker with Compose

The repository pins pnpm 12.4.2 through `packageManager`. Run `pnpm` directly: pnpm reads the pin and switches to that version itself. Corepack is not used, because pnpm refuses to switch versions when it runs under Corepack.

## Evaluator walkthrough

From a fresh checkout, with Docker running and host ports 5432, 5433 and 3000 free. These steps use the checkout's own Compose services; [`./dev.sh`](#quick-local-development) is the alternative for day-to-day work. Use one path at a time, because both publish PostgreSQL on port 5432.

```sh
# 1. Install locked dependencies
pnpm install --frozen-lockfile

# 2. Local configuration (local-only example values, no external credentials)
cp .env.example .env
# Prisma and the API do not read .env; export the values it documents:
export DATABASE_URL=postgresql://scos:scos@localhost:5432/scos
export DATABASE_TEST_URL=postgresql://scos_test:scos_test@localhost:5433/scos_test

# 3. Start the development (5432) and disposable test (5433) databases
docker compose up -d --wait postgres postgres-test

# 4. Apply migrations, then 5. insert the six seed warehouses
pnpm db:migrate
pnpm db:seed

# 6. Build and start the API on http://localhost:3000 (leave it running;
#    use a second terminal with both DATABASE_URL and DATABASE_TEST_URL
#    exported for the rest)
pnpm api:start
```

7. Open the docs: Swagger UI at <http://localhost:3000/docs> and the specification at <http://localhost:3000/openapi.json>. `curl http://localhost:3000/health` returns `{"status":"ok"}`.
8. Try the ordering flow with the [curl examples](#try-the-api-with-curl).
9. Run the checks. Stop the API first if you want an idle machine; the tests do not use it or the development database.

   ```sh
   pnpm build && pnpm typecheck && pnpm lint && pnpm format:check
   pnpm test               # unit tests with coverage gates, and the Worker in workerd
   pnpm test:integration   # real PostgreSQL via DATABASE_TEST_URL: persistence,
                           # full-stack API acceptance, OpenAPI conformance, Worker
   ```

   The integration suites fail, never skip, when `DATABASE_TEST_URL` is unset or the test database is unreachable.

10. Tear down with Ctrl+C for the API, then `docker compose down` (see [Stopping and removing local data](#stopping-and-removing-local-data) to delete the development data too).

Independent acceptance evidence, mapping each requirement to a test or reproducible step, is recorded in [docs/acceptance-evidence.md](docs/acceptance-evidence.md).

## Quick local development

```sh
./setup.sh
./dev.sh
```

Setup installs locked dependencies and preserves existing `.env` configuration.
Development startup reuses or starts shared PostgreSQL, creates a separate
worktree database, and finds an available API port starting at 3000. See
[local development](docs/local-development.md) for container selection and
configuration. Ctrl+C stops the API while preserving the shared database; see
[Stopping and removing local data](#stopping-and-removing-local-data) to remove
the worktree database or the shared container.

## Install and verify

```sh
pnpm install --frozen-lockfile
pnpm exec tsc --version
pnpm build
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
```

The compiler command must report `Version 7.0.2`. The separate quality commands build every package, type-check, lint with Oxlint, check formatting with Oxfmt, and run the current Vitest suites through Turbo. Each unit suite enforces at least 80% statement, branch, function, and line coverage. Coverage summaries are written to `coverage/` at the repository root and in each tested package.

Installing dependencies also enables the [husky](https://typicode.github.io/husky/) `pre-commit` hook in `.husky` (the `prepare` script runs `husky`). Before each commit, [lint-staged](https://github.com/lint-staged/lint-staged) formats the staged files with Oxfmt, re-stages them, and lints the staged JavaScript and TypeScript with Oxlint (configured under `lint-staged` in `package.json`); the hook then runs the Turbo typecheck for the whole workspace as CI does. Use `git commit --no-verify` to skip it for a single commit, or `HUSKY=0` to disable hooks.

The workspace contains:

- `packages/core`: framework-independent business core; ordering rules, use cases, and ports belong here
- `packages/persistence`: outbound database adapter boundary, depending inward on core
- `apps/api`: composition root, depending on core and persistence
- `libs/typescript-config`: shared TypeScript compiler policy consumed through the `@scos/typescript-config` workspace package

See [architecture](docs/architecture.md) for the hexagonal layering, the dependency rule, and where new code belongs.

The library packages (`packages/core`, `packages/persistence`) build with tsdown into ESM JavaScript and declaration files in their `dist` directories, and package exports point to those files. Their third-party and `@scos/*` dependencies stay external; `packages/persistence` additionally bundles its generated Prisma client (`src/generated/prisma`, produced by the `generate` task) and keeps `pg`, `@prisma/client`, `@prisma/adapter-pg` and `@scos/core` external. Declarations are emitted by the TypeScript 7 compiler; `tsc --noEmit` remains the type checker.

The API application builds with esbuild (`apps/api/build.mjs`) into a self-contained ESM bundle, `apps/api/dist/node.js` (one file per runtime entry point in `apps/api/src/entrypoints/`), for Node.js, with AWS Lambda handlers to follow later (#14, deferred). The Cloudflare Worker, the first hosted target, is bundled by Wrangler from `src/entrypoints/worker.ts` instead. The esbuild bundle inlines the built workspace libraries and third-party runtime dependencies, so it runs without `node_modules`. Only Node.js built-ins and pg's optional native addon, `pg-native`, stay external. The API publishes no package exports or declarations.

Each package's `turbo.json` declares its build configuration (`tsdown.config.ts` or `build.mjs`), `tsconfig.json`, `package.json`, and `src` as build inputs, and builds after its workspace dependencies. Turbo treats the shared TypeScript configuration as a global dependency so compiler-policy changes invalidate affected cached tasks.

## Local API

The API serves `POST /api/v1/orders/verify`, `POST /api/v1/orders`, and `GET /health`; see [apps/api/README.md](apps/api/README.md) for request and response shapes, status codes, and retry guidance. `./dev.sh` is the easiest way to run it. To start it directly, export `DATABASE_URL` (required; the server validates it at startup and exits nonzero without listening if it is missing or malformed). Turbo builds the workspace dependencies first:

```sh
export DATABASE_URL=postgresql://scos:scos@localhost:5432/scos
pnpm api:dev
```

The server listens on port 3000 by default. Set `PORT` to use a different port:

```sh
PORT=8080 pnpm api:dev
```

For a production-style local start, Turbo builds the API and its workspace dependencies before running the bundled server:

```sh
PORT=8080 pnpm api:start
```

Check application liveness with `curl http://localhost:8080/health`. The endpoint returns HTTP 200 with `{"status":"ok"}` and does not require PostgreSQL to be reachable.

Interactive API documentation is served at `http://localhost:8080/docs` and the OpenAPI 3.1 specification at `/openapi.json`. hono-openapi generates the specification from the route contracts; it is not committed. `pnpm build` writes it to `apps/api/dist/openapi.json` (the same bytes as `/openapi.json`) without a server or database, and `pnpm openapi:export` writes it on demand.

The same app also runs as a Cloudflare Worker locally (`pnpm --filter @scos/api dev:worker`, through Wrangler and a local Hyperdrive binding); see [Cloudflare Worker](apps/api/README.md#cloudflare-worker).

## Try the API with curl

These requests run against a freshly seeded database and the API on port 3000 (`BASE=http://localhost:3000`; use the URL `./dev.sh` prints instead if it chose another port). The amounts below are the actual responses; `orderNumber` is random, and later orders change stock and therefore amounts. Field meanings, every status code and the validation rules are in [apps/api/README.md](apps/api/README.md#endpoints).

```sh
BASE=http://localhost:3000
```

Verify an order (advisory; stores and reserves nothing). 150 units to Berlin, served from the Warsaw warehouse with a 15% discount:

```sh
curl -sS "$BASE/api/v1/orders/verify" -H 'Content-Type: application/json' \
  -d '{"quantity":150,"latitude":52.52,"longitude":13.405}'
```

```json
{
  "valid": true,
  "reason": null,
  "quantity": 150,
  "destination": { "latitude": 52.52, "longitude": 13.405 },
  "merchandiseSubtotal": "22500.00",
  "discountRate": "0.15",
  "discountAmount": "3375.00",
  "discountedMerchandiseTotal": "19125.00",
  "shippingCost": "281.96",
  "orderTotal": "19406.96",
  "allocations": [
    {
      "warehouseId": "01996000-0000-7000-8000-000000000005",
      "quantity": 150,
      "distanceKm": 514.9927163724758
    }
  ]
}
```

Submit it with a client-generated `submissionId` (any 1-255 character string; generate a new one per order). `201 Created` returns the accepted Order and deducts 150 units of stock:

```sh
curl -sS -w '\nHTTP %{http_code}\n' "$BASE/api/v1/orders" -H 'Content-Type: application/json' \
  -d '{"submissionId":"checkout-7f3a-attempt-1","quantity":150,"latitude":52.52,"longitude":13.405}'
```

```text
{"orderNumber":"SO-2EP5S908HX6Y","submissionId":"checkout-7f3a-attempt-1","quantity":150,"destination":{"latitude":52.52,"longitude":13.405},"unitPrice":"150.00","merchandiseSubtotal":"22500.00","discountRate":"0.15","discountAmount":"3375.00","discountedMerchandiseTotal":"19125.00","shippingCost":"281.96","orderTotal":"19406.96","allocations":[{"warehouseId":"01996000-0000-7000-8000-000000000005","quantity":150}]}
HTTP 201
```

Repeat exactly the same request (a double click, or a retry after a lost response). It returns `201` with the original Order, byte for byte, including the same `orderNumber`; no second Order is stored and stock is not deducted again.

Reuse the `submissionId` with a different body (here 151 units). Nothing is stored or revealed about the original Order:

```sh
curl -sS -w '\nHTTP %{http_code}\n' "$BASE/api/v1/orders" -H 'Content-Type: application/json' \
  -d '{"submissionId":"checkout-7f3a-attempt-1","quantity":151,"latitude":52.52,"longitude":13.405}'
```

```text
{"error":{"code":"SUBMISSION_ID_CONFLICT","message":"This submissionId was already used for an Order with a different quantity or destination. Use a new submissionId for a different order."}}
HTTP 409
```

A business rejection: more units than the six warehouses hold together (2,556). `422` carries the estimate that caused it; nothing is stored, so the same `submissionId` may be sent again later. Shipping above 15% of the discounted merchandise total is the other `422` (`SHIPPING_EXCEEDS_LIMIT`, for example 10 units to Sydney at `-33.9, 151.2`).

```sh
curl -sS -w '\nHTTP %{http_code}\n' "$BASE/api/v1/orders" -H 'Content-Type: application/json' \
  -d '{"submissionId":"checkout-9b21-attempt-1","quantity":3000,"latitude":52.52,"longitude":13.405}'
```

```text
{"error":{"code":"INSUFFICIENT_STOCK","message":"Available stock cannot fulfil the requested quantity. Nothing was stored; the same submissionId may be reused."},"estimate":{"valid":false,"reason":"INSUFFICIENT_STOCK","quantity":3000,"destination":{"latitude":52.52,"longitude":13.405},"merchandiseSubtotal":"450000.00","discountRate":"0.20","discountAmount":"90000.00","discountedMerchandiseTotal":"360000.00","shippingCost":null,"orderTotal":null,"allocations":[]}}
HTTP 422
```

Malformed input is `400 INVALID_REQUEST` with one issue per failing field; it stores nothing and consumes no `submissionId`. Malformed JSON, a missing `Content-Type: application/json`, unknown fields and strings for numbers (`"quantity":"10"`) are `400` too.

```sh
curl -sS -w '\nHTTP %{http_code}\n' "$BASE/api/v1/orders" -H 'Content-Type: application/json' \
  -d '{"submissionId":" checkout-7f3a-attempt-1","quantity":0,"latitude":52.52,"longitude":13.405}'
```

```text
{"error":{"code":"INVALID_REQUEST","message":"The request body is invalid.","issues":[{"path":["submissionId"],"message":"Submission key must not have leading or trailing whitespace."},{"path":["quantity"],"message":"Too small: expected number to be >0"}]}}
HTTP 400
```

**Retrying.** After `503 SERVICE_UNAVAILABLE` (sent with `Retry-After: 1`), a `500`, a client timeout, a dropped connection or any other response you did not receive, send the same body with the same `submissionId` again. If an earlier attempt committed, you get that Order back (`201`) and stock is not deducted twice; otherwise the request is evaluated afresh. Use a new `submissionId` only for a new order. curl can do this itself, because `--retry` resends the same body on `500`, `503` and `504` (and timeouts), honouring `Retry-After`:

```sh
curl -sS --retry 3 --max-time 90 "$BASE/api/v1/orders" -H 'Content-Type: application/json' \
  -d '{"submissionId":"checkout-7f3a-attempt-1","quantity":150,"latitude":52.52,"longitude":13.405}'
```

See [transient failures and retries](apps/api/README.md#transient-failures-and-retries) for what `503` and `500` do and do not guarantee.

## Local PostgreSQL

Copy `.env.example` to `.env` for local configuration. The committed values are local-only examples and contain no external credentials.

Start both databases and wait for their health checks:

```sh
docker compose up -d --wait postgres postgres-test
```

The development database persists in the `scos-postgres-data` volume and listens on port 5432. The test database listens on port 5433 and stores its data in container-scoped temporary memory. It is separate so integration tests cannot alter development data.

Run the real-database integration harness:

```sh
DATABASE_TEST_URL=postgresql://scos_test:scos_test@localhost:5433/scos_test \
  pnpm test:integration
```

The harness creates a uniquely named schema, proves a transaction rollback leaves no rows, and drops the schema when the test completes. The persistence schema tests create a uniquely named database beside `scos_test` for each test file, apply the real migrations, and drop it afterwards. Database integration tasks are uncached.

## Stopping and removing local data

Stop the API with Ctrl+C in its terminal (`pnpm api:start`, `pnpm api:dev` or `./dev.sh`). It closes the listener, then its database connections.

**Compose path** (the walkthrough and [Local PostgreSQL](#local-postgresql)). Run from the same checkout, because Compose names the project after its directory:

```sh
docker compose down             # stop and remove both containers; keeps the development volume
docker compose down --volumes   # also deletes the scos-postgres-data volume
```

`down --volumes` permanently deletes every Order and all stock changes in the development database; the next `pnpm db:seed` starts from the seed stock again. The test database never keeps data.

**`./dev.sh` path.** The launcher never stops the shared container or deletes data. The container is shared by every worktree, so check that no other worktree still needs it before stopping it or deleting its volume. To remove only this worktree's database, stop its API first, then run from the worktree root:

```sh
db="scos_wt_$(node -p 'require("node:crypto").createHash("sha256").update(process.cwd()).digest("hex").slice(0, 24)')"
docker exec scos-local-postgres-1 psql -X -U scos -d postgres -c "DROP DATABASE IF EXISTS \"$db\""
```

If the launcher created the container (Compose project `scos-local`):

```sh
docker compose --project-name scos-local -f compose.yaml down            # stop; all worktree databases kept
docker compose --project-name scos-local -f compose.yaml down --volumes  # delete scos-local_scos-postgres-data
```

Dropping a worktree database, or `down --volumes`, is irreversible: it deletes that data (for `--volumes`, every worktree's database). If `./dev.sh` reused a container you started yourself, use that container's name and user in the `docker exec` command and manage the container the way you created it. See [local development](docs/local-development.md#stopping-and-removing-local-data) for details.

## Database schema, migrations, and seed

The PostgreSQL schema, Prisma client, migrations, and warehouse seed live in `packages/persistence`. With `DATABASE_URL` exported:

```sh
pnpm db:migrate   # apply pending migrations
pnpm db:seed      # apply migrations, then insert missing seed warehouses
```

Seeding never replenishes consumed stock. The destructive `db:reset` requires `SCOS_CONFIRM_DATABASE_RESET` to match the target database name. See [database schema](docs/database-schema.md) for the entity relationships and schema decisions, and [local development](docs/local-development.md) for command details.

## Numeric limits and precision

| Topic              | Rule                                                                                                                                                                                                           | Details                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Decimal arithmetic | Money uses an isolated `decimal.js` clone with 40 significant digits and `ROUND_HALF_UP`; constants are built from strings. Discounts are exact at cents; only the shipping charge is rounded, once, to cents. | [core numeric policy](packages/core/README.md#numeric-policy)            |
| Money on the wire  | Decimal strings with two fractional digits (`"150.00"`); `discountRate` is a two-decimal string; `shippingCost` and `orderTotal` are `null` for insufficient stock.                                            | [API endpoints](apps/api/README.md#endpoints)                            |
| Distance           | Haversine in JavaScript `number` with Earth radius `EARTH_RADIUS_KM = 6371.0088` km (IUGG mean radius); `distanceKm` is returned unrounded.                                                                    | [core numeric policy](packages/core/README.md#numeric-policy)            |
| Quantity           | JSON integer from 1 to `MAX_QUANTITY` = 66,666,666 (floor(9,999,999,999.99 / 150)), a storage-representability bound rather than a business cap; larger values are `400`.                                      | [supported input bounds](packages/core/README.md#supported-input-bounds) |
| Coordinates        | JSON numbers, latitude -90 to 90 and longitude -180 to 180 inclusive, never coerced from strings; stored as `double precision`.                                                                                | [request validation](apps/api/README.md#request-validation)              |
| Stored money       | `NUMERIC(12,2)`, at most 9,999,999,999.99 and nonnegative; `discount_rate` is `NUMERIC(3,2)`. Out-of-range amounts fail instead of being rounded.                                                              | [money and coordinates](docs/database-schema.md#money-and-coordinates)   |

## Continuous integration

The `CI` workflow runs for pull requests targeting `main` and pushes to `main`. The pull-request policy workflows run only against `main`. Validation jobs have read-only repository access, cancel superseded pull-request runs, have bounded timeouts, and do not deploy.

The workflow exposes these stable check names:

- `Workspace checks`: frozen install followed by separate Turbo build, typecheck, Oxlint, Oxfmt, and test steps
- `Coverage comment`: aggregate Vitest coverage reporting on same-repository pull requests
- `PostgreSQL integration`: a disposable PostgreSQL 18 service and these steps:
  - a guard that fails if any integration test under `apps/api/test` or `packages/persistence/test` uses `.skip`, `.skipIf`, `.runIf`, `.todo` or `.only`;
  - the uncached Turbo `test:integration` task, which builds first and then runs the persistence integration tests in `packages/persistence` (connectivity, migrations, schema, seed, inventory reader), the full-stack ordering and API acceptance tests through the composed API in `apps/api`, the OpenAPI conformance test (the served document is a valid OpenAPI 3.1 document, real responses conform to its schemas, and `dist/openapi.json` equals the served `/openapi.json`), and the Worker suite in workerd against the same database;
  - a check that the build generated `apps/api/dist/openapi.json` and that it is not tracked by Git (the specification is generated, never committed), and an upload of it as the `openapi-specification` artifact, kept for 7 days
- `PR title`: Conventional Commit title validation on opened, edited, reopened, and synchronized pull requests
- `Code scanner`: verified-secret scanning across the pull request's explicit base and head revisions
- `Actionlint`: workflow validation when `.github/workflows/**` or `.github/actions/**` changes; local-action changes trigger the workflow but actionlint validates workflow files

The title and code-scanner checks use local composite actions copied from the repository-management baseline. The title composite passes untrusted title text through an environment variable to the repository's tested Node validator; it never interpolates the title into a shell command. The scanner checks full history with TruffleHog's verified-secret mode and converts scanner failure into a failed check.

The workspace job uploads the root, API, core, and persistence JSON coverage summaries even when a coverage threshold rejects the test step. A separate same-repository pull-request job receives only `pull-requests: write` permission to create or update the aggregate coverage comment. Fork pull requests skip that comment job and receive no write permission.

The workspace and PostgreSQL jobs use the repository's `TURBO_API` and `TURBO_TEAM` variables with the `TURBO_TOKEN` and `TURBO_REMOTE_CACHE_SIGNATURE_KEY` secrets for signed remote caching. Pull requests without those secrets, including forks, continue with Turbo's local cache. Database integration remains uncached. Cache configuration is consumed by Turbo itself and is not passed through to application tasks.

The database client gives connection and query operations five-second timeouts, while the integration test and Actions job have broader bounded timeouts. An unavailable database therefore fails the existing integration harness clearly instead of hanging or being skipped.

Pull request titles must use one of these forms:

```text
type: description
type(scope): description
type(scope)!: description
```

Allowed types are `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, and `revert`. The scope is optional but cannot be empty; `!` marks a breaking change. The description must be nonempty and remain on one line. Examples include `feat(api): add order verification`, `fix: prevent duplicate orders`, and `feat(api)!: change submission contract`.

Changing a pull request title reruns the title check without requiring a code push. Intermediate commit messages are not validated by this rule. Branch protection and repository rules remain repository settings outside this scaffold.

## Limitations and next steps

These are known gaps, not completed work. The acceptance evidence for the current revision is in [docs/acceptance-evidence.md](docs/acceptance-evidence.md).

- **No hosted deployment is provisioned.** Cloudflare Workers with PlanetScale Postgres through Hyperdrive is the first hosted target ([ADR 0005](docs/adr/0005-cloudflare-first-deployment.md)): the Hyperdrive design (#28), then the deployment pipeline (#15), then the hosted demonstration (#33). The [PlanetScale bootstrap](docs/planetscale-bootstrap.md) and the [deployment pipeline](docs/deployment-pipeline.md) (Terraform, R2 state, GitHub Actions) are in place. `Deploy Prod` (`deploy-prod.yml`, which calls the shared `deploy.yml`) runs on every merge to `main` with no approval. As of 2026-09-20 every required setting is present, so the next merge deploys, creates the PlanetScale database and starts billing; disable that workflow first if that is not wanted. Until then the Worker runs only locally, in `wrangler dev` and workerd tests.
- **AWS Lambda is deferred** (#14). The per-endpoint apps and the Lambda notes in [apps/api/README.md](apps/api/README.md#notes-for-lambda-deployment-14-deferred) are kept for when it resumes, but no Lambda handler or packaging exists yet.
- **No authentication or access control.** Any client that can reach the API can verify and submit orders. A `submissionId` is a retry key, not a credential.
- **Hosted-only checks are not verified.** They need a real Cloudflare account and are listed in [Workers limitations](docs/observability.md#workers-limitations) and [Limitations](docs/observability.md#limitations):
  - Hyperdrive transaction-mode pooling, including that the submission transaction's transaction-local timeouts carry over and nothing relies on session state;
  - Hyperdrive query caching staying disabled, so inventory reads are never stale;
  - the telemetry flush and per-request pool close under `ctx.waitUntil`, and a deployed Worker with its collector down logging only export warnings;
  - Workers Logs and Logpush ingestion, CPU time on the Free plan with a Prisma client per request, and replacing the placeholder Hyperdrive ID.
- **No latency or throughput targets are agreed.** Measurements are reported as observed, without pass/fail targets.
- **A silent established database connection is not bounded** until the operating system reports it broken, because TCP keepalive is not configured ([database timeouts](apps/api/README.md#database-timeouts)).
