# @scos/api-acceptance

The QA-owned acceptance suite for the SCOS ordering API.

This app exists to make one boundary visible in the repository: **developer
tests and independent acceptance testing are not the same thing, and they do
not share a process.**

- `apps/api` holds the developer suite — unit tests and the full-stack
  integration tests in `apps/api/test/*.integration.test.ts`. They are owned by
  the backend developers, they import API source, and they compose the
  application in the test process.
- `apps/api-acceptance` holds the acceptance suite. It is owned by QA, and it
  **never imports `@scos/api` or anything under `apps/api/src`**. Its entire
  contact with the API is:
  - the built artifacts `apps/api/dist/node.js` and `apps/api/dist/openapi.json`,
  - environment variables,
  - HTTP,
  - and the server process's stdout and stderr.

Because of that, the expectations here are independent. The amounts, discount
tiers, allocation order and shipping limit come from an oracle written from the
[PRD](../../docs/prd/scos-ordering.md) in `test/support/oracle.ts`, never from
`@scos/core`. If the product and the oracle disagree, the suite fails — which
is the point.

## How it runs the API

A Vitest global setup (`test/global-setup.ts`) prepares the whole run before
any test executes, in one of two modes.

### Default: the suite starts the server

1. Creates a disposable database beside `scos_test`, migrates it with the
   persistence package's own Prisma CLI, and seeds the six PRD warehouses.
2. Starts the built API as a real child process:
   `node apps/api/dist/node.js` with `PORT=0` and an environment **allowlist**,
   so a developer's own `DATABASE_URL` or stray `OTEL_*` variables can never
   reach the server under test.
3. Waits for the server's own "listening" log record on stdout — **not** a
   `/health` probe. A probe would record an extra trace and an extra request
   log that the telemetry tests would then have to reason about. The record
   carries the bound port as a typed `server.port` field, so `PORT=0` gives an
   ephemeral port with no port-picking race.
4. Afterwards, stops the server and drops the database. A run leaves no
   process listening and no database behind.

### Real server: `API_BASE_URL`

With `API_BASE_URL` set, **no shared server is started**. Every test calls that
URL, and `DATABASE_TEST_URL` must be the database that server uses: the suite
reads and resets stock through it exactly as in the default mode. Reachability
is checked with a bare TCP connect rather than a request, for the same reason
the readiness check is a log line.

> **This mode migrates, seeds and resets the database you name.** It is for a
> disposable database only. Do not point it at a deployed database whose
> contents must survive — the read-only variant for a hosted environment is
> issue #33.

### Tests that need a different server

Some scenarios cannot use the shared server because they need different
settings. Those always start their **own** extra API process from the same
built artifact, in both modes:

| Scenario                                                            | Why it needs its own process                                                                                   |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Telemetry (`telemetry.acceptance.test.ts`)                          | OTLP/HTTP protobuf export to a fake collector in the test process, sampler ratio 1, JSON logs read from stdout |
| Database unreachable (`routing`, `openapi`, telemetry's error case) | a `DATABASE_URL` nothing listens on, to observe the documented 500/503                                         |
| Restart recovery (`submit`)                                         | a second listener over the same database                                                                       |

Telemetry is asserted **after the process has stopped**, because shutdown
flushes batched spans and metrics.

Test files run one at a time (`fileParallelism: false`) against the shared
server and database, and any test that needs controlled stock resets it
**through the database**, never through the API.

## Running it

```bash
# Default: the suite starts and stops its own server.
DATABASE_TEST_URL=postgresql://scos_test:scos_test@localhost:5433/scos_test \
  pnpm exec turbo run test:integration --filter=@scos/api-acceptance

# The same thing, from the repository root.
DATABASE_TEST_URL=postgresql://scos_test:scos_test@localhost:5433/scos_test \
  pnpm test:acceptance
```

Against a server you started yourself:

```bash
# Terminal 1: the API over a migrated scos_test.
DATABASE_URL=postgresql://scos_test:scos_test@localhost:5433/scos_test pnpm api:start

# Terminal 2: the suite against it. DATABASE_TEST_URL is that same database.
API_BASE_URL=http://localhost:3000 \
DATABASE_TEST_URL=postgresql://scos_test:scos_test@localhost:5433/scos_test \
  pnpm exec turbo run test:integration --filter=@scos/api-acceptance
```

Turbo builds `@scos/api` before this suite runs (`turbo.json` declares
`@scos/api#build` explicitly, because this app deliberately does **not** depend
on `@scos/api`).

## It fails; it never skips

`DATABASE_TEST_URL` is required. Without it the run fails rather than quietly
passing, and CI rejects the Vitest modifiers that skip, defer or focus tests in
the integration trees. Each of these produces a message that says what to do:

| Situation                         | What you see                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| The API was not built             | `The API build artifact …/dist/node.js is missing: run \`pnpm --filter @scos/api build\` first.`                         |
| `DATABASE_TEST_URL` unset         | `DATABASE_TEST_URL must point to the test database; the acceptance suite fails rather than skipping without it.`         |
| The server exits before listening | `The API process exited before it reported that it was listening (code …)`, with the last lines of its stdout and stderr |
| The server never reports a port   | `The API process did not report that it was listening within 30000 ms.`, with its output                                 |
| `API_BASE_URL` unreachable        | `API_BASE_URL … is not reachable: connect ECONNREFUSED …`                                                                |

## Layout

```
test/
  global-setup.ts          the whole run: database, server, teardown
  *.acceptance.test.ts     the suites
  support/
    environment.ts         the only module that reads process.env or points into apps/api
    provision.ts           create, migrate, seed and drop the run's database
    api-process.ts         start and stop the built API as a child process
    shared-api.ts          the served API as the test files see it
    database.ts            stock and persisted state, over pg
    http.ts                requests and the documented error envelope
    prd.ts                 the PRD warehouse table and contract constants
    oracle.ts              the independent expectations, written from the PRD
    logs.ts                the server's Pino JSON records
    otlp/                  a fake OTLP collector and a minimal protobuf decoder
```

`test/support/otlp/` decodes OTLP protobuf with a small hand-written wire
reader rather than a dependency: `@opentelemetry/otlp-transformer` exports only
a serializer, and this app deliberately carries no `@opentelemetry/*`
dependency at all.
