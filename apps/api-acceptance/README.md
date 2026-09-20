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

## The runner

Playwright Test, over HTTP only. **No browser is involved and none needs to be
downloaded**: nothing here asks for Playwright's `page`, `browser` or `context`
fixtures, so `playwright install` is not part of this app's setup. `pnpm
install` is enough — pnpm does not run a dependency's build scripts unless it
is listed in `allowBuilds` (`pnpm-workspace.yaml`), and `playwright` is not
listed. To be explicit about it anywhere else, `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`
says the same thing to the package directly.

`playwright.config.ts` declares two projects, and the separation between them
is a safety property rather than a convenience:

| Project      | Files                          | Global setup | Retries | Target                                         |
| ------------ | ------------------------------ | ------------ | ------- | ---------------------------------------------- |
| `acceptance` | `test/*.acceptance.test.ts`    | yes          | 0       | a server and database this run provisions      |
| `hosted`     | `test/hosted/*.hosted.test.ts` | **no**       | 1       | the live deployment named by `HOSTED_BASE_URL` |

The acceptance project has **no retries on purpose**: it asserts on stock
deltas and on "nothing was stored", and a silent retry could hide a real
oversell behind a green run. The hosted project retries once, because every
assertion is a round trip to a remote Worker; that retry costs no stock,
because a run's submissionIds are stable (`SCOS_HOSTED_RUN_ID`), so a repeated
submission is a replay of the same Order rather than a second one.

Everything runs in a single worker (`workers: 1`): the acceptance run shares
one served API and one database, and the hosted scenarios observe one
deployment in order.

Reports are written under `test-results/<project>/`, which is gitignored:
`junit.xml` for CI, `html/` to browse a failure with its full context, and
`artifacts/` for per-test attachments. Progress goes to the `list` reporter
locally and to the `github` reporter on CI.

## How it runs the API

A Playwright global setup (`test/global-setup.ts`) prepares the whole run
before any test executes, in one of two modes. It runs in Playwright's main
process and hands the base URL, the database URL and the mode to the test
files through environment variables of this app's own
(`test/support/shared-api.ts`); a worker starts after the setup has resolved
and inherits them, which is what lets a test file name the API under test at
module scope. It is wired only when the `acceptance` project is selected, so
`run test:hosted` loads no global setup at all.

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

> **This mode migrates, seeds and resets the database you name.** So it makes
> you name it: set `SCOS_CONFIRM_ACCEPTANCE_RESET` to that database's name, the
> same way `SCOS_CONFIRM_DATABASE_RESET` guards `pnpm db:reset`. Setting
> `API_BASE_URL` alone is not consent to lose the data behind it. It is for a
> disposable database only. For a hosted environment whose data must survive,
> use the read-only hosted suite in [`test/hosted/`](test/hosted/) instead
> (`pnpm --filter @scos/api-acceptance run test:hosted`, driven by
> `HOSTED_BASE_URL`); it never connects to a database and never resets stock.

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

Test files run one at a time (the acceptance project runs in a single worker)
against the shared server and database, and any test that needs controlled
stock resets it **through the database**, never through the API.

## Running it

```bash
# Default: the suite starts and stops its own server.
DATABASE_TEST_URL=postgresql://scos_test:scos_test@localhost:5433/scos_test \
  pnpm exec turbo run test:acceptance --filter=@scos/api-acceptance

# The same thing, from the repository root.
DATABASE_TEST_URL=postgresql://scos_test:scos_test@localhost:5433/scos_test \
  pnpm test:acceptance
```

The task is called **`test:acceptance`**, not `test:integration`: `apps/api`
and `packages/persistence` own `test:integration`, which is the developers'
full-stack and database suites. This one is the independent acceptance run,
and is named for what it is.

Listing what would run needs no database and starts nothing:

```bash
pnpm --filter @scos/api-acceptance exec playwright test --project=acceptance --list
pnpm --filter @scos/api-acceptance exec playwright test --project=hosted --list
```

Against a server you started yourself:

```bash
# Terminal 1: the API over a migrated scos_test.
DATABASE_URL=postgresql://scos_test:scos_test@localhost:5433/scos_test pnpm api:start

# Terminal 2: the suite against it. DATABASE_TEST_URL is that same database,
# and SCOS_CONFIRM_ACCEPTANCE_RESET names it, because the run resets it.
API_BASE_URL=http://localhost:3000 \
DATABASE_TEST_URL=postgresql://scos_test:scos_test@localhost:5433/scos_test \
SCOS_CONFIRM_ACCEPTANCE_RESET=scos_test \
  pnpm exec turbo run test:acceptance --filter=@scos/api-acceptance
```

Turbo builds `@scos/api` before this suite runs (`turbo.json` declares
`@scos/api#build` explicitly, because this app deliberately does **not** depend
on `@scos/api`).

## It fails; it never skips

`DATABASE_TEST_URL` is required. Without it the run fails rather than quietly
passing, and CI rejects the modifiers that skip, defer or focus tests in the
integration trees — `.skip`, `.skipIf`, `.runIf`, `.todo` and `.only`.
Playwright adds two more of its own, `test.fixme()` and `test.fail()`; neither
appears anywhere in this app, and `forbidOnly` in `playwright.config.ts` fails
a run that smuggles in a focused test. Each of these produces a message that says what to do:

| Situation                                         | What you see                                                                                                                        |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| The API was not built                             | `The API build artifact …/dist/node.js is missing: run \`pnpm --filter @scos/api build\` first.`                                    |
| `DATABASE_TEST_URL` unset                         | `DATABASE_TEST_URL must point to the test database; the acceptance suite fails rather than skipping without it.`                    |
| The server exits before listening                 | `The API process exited before it reported that it was listening (code …)`, with the last lines of its stdout and stderr            |
| The server never reports a port                   | `The API process did not report that it was listening within 30000 ms.`, with its output                                            |
| `API_BASE_URL` unreachable                        | `API_BASE_URL … is not reachable: connect ECONNREFUSED …`                                                                           |
| `API_BASE_URL` set without the reset confirmation | `Refusing to run against API_BASE_URL with database "scos_test". … To confirm, rerun with SCOS_CONFIRM_ACCEPTANCE_RESET=scos_test.` |

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
    each.ts                the titles of table-driven tests (Playwright has no test.each)
    logs.ts                the server's Pino JSON records
    otlp/                  a fake OTLP collector and a minimal protobuf decoder
```

`test/support/otlp/` decodes OTLP protobuf with a small hand-written wire
reader rather than a dependency: `@opentelemetry/otlp-transformer` exports only
a serializer, and this app deliberately carries no `@opentelemetry/*`
dependency at all.
