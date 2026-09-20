# SCOS Ordering

Backend for ordering SCOS Station P1 Pro devices. A Hono API verifies orders (`POST /api/v1/orders/verify`), accepts them idempotently by client `submissionId` (`POST /api/v1/orders`), and serves `GET /health`, the generated OpenAPI 3.1 specification at `GET /openapi.json`, and Swagger UI at `GET /docs`. Business rules live in a framework-independent core, and orders, allocations and warehouse stock are stored in PostgreSQL through Prisma. The API runs locally as a Node.js server and is deployed to Cloudflare Workers from its Worker entry point (`apps/api/src/entrypoints/worker.ts`). It is live at <https://scos-api.bonanaaaaaa-scos.workers.dev> — public, unauthenticated, and stocked with inventory that is never replenished, so read [hosted demonstration](docs/hosted-demonstration.md) and [Limitations and next steps](#limitations-and-next-steps) before submitting an order there.

New here? [SUBMISSION.md](SUBMISSION.md) maps the challenge's requirements to the code that satisfies them, and explains the decisions behind it. To find your way around the repository, start with the [repository map](docs/architecture.md#repository-map), which names every directory's job and says which document answers which question. To run the API yourself, follow the [evaluator walkthrough](#evaluator-walkthrough) from a fresh checkout.

## Prerequisites

- Node.js 24.15.0 (also pinned in `.node-version` and `.nvmrc`)
- pnpm (any recent version; it switches to the pinned version itself)
- Docker with Compose

The repository pins pnpm 12.4.2 through `packageManager`. Run `pnpm` directly: pnpm reads the pin and switches to that version itself. Corepack is not used, because pnpm refuses to switch versions when it runs under Corepack.

## Evaluator walkthrough

From a fresh checkout, with Docker running and host ports 5432, 5433 and 3000 free. These steps use the checkout's own Compose services; [`./dev.sh`](docs/local-development.md#first-run-in-each-worktree) is the alternative for day-to-day work. Use one path at a time, because both publish PostgreSQL on port 5432.

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
8. Try the ordering flow with the [curl examples](apps/api/README.md#try-it-with-curl).
9. Run the checks. Stop the API first if you want an idle machine; the tests do not use it or the development database.

   ```sh
   pnpm build && pnpm typecheck && pnpm lint && pnpm format:check
   pnpm test               # unit tests with coverage gates, and the Worker in workerd
   pnpm test:integration   # real PostgreSQL via DATABASE_TEST_URL: persistence,
                           # the full-stack API developer suite, the QA acceptance
                           # suite against the served API, and the Worker
   ```

   The integration suites fail, never skip, when `DATABASE_TEST_URL` is unset or the test database is unreachable.

   Two suites cover the API, and the split is deliberate. `apps/api` holds the developer suite, which composes the application in the test process. [`apps/api-acceptance`](apps/api-acceptance/README.md) holds the QA-owned acceptance suite, which never imports API source: it starts the built artifact as a real server and talks to it only over HTTP. Run it alone with `pnpm test:acceptance`, or point it at a server you started yourself with `API_BASE_URL`. That mode migrates, seeds and resets whatever database `DATABASE_TEST_URL` names, so it refuses to run until `SCOS_CONFIRM_ACCEPTANCE_RESET` names that database too.

10. Tear down with Ctrl+C for the API, then `docker compose down` (see [Stopping and removing local data](docs/local-development.md#stopping-and-removing-local-data) to delete the development data too).

Independent acceptance evidence, mapping each requirement to a test or reproducible step, is recorded in [docs/acceptance-evidence.md](docs/acceptance-evidence.md).

## Where everything is

| I want to…                                   | Go to                                                            |
| -------------------------------------------- | ---------------------------------------------------------------- |
| See how the challenge's requirements are met | [SUBMISSION.md](SUBMISSION.md)                                   |
| Find my way around the directories           | [repository map](docs/architecture.md#repository-map)            |
| Run and develop it locally                   | [local development](docs/local-development.md)                   |
| Call the API, with worked curl examples      | [apps/api](apps/api/README.md#try-it-with-curl)                  |
| Read the endpoint contracts and error codes  | [apps/api](apps/api/README.md#endpoints)                         |
| Understand the design and the domain model   | [architecture](docs/architecture.md)                             |
| Know why a decision was made                 | [ADRs](docs/adr/) · [design decisions](docs/design-decisions.md) |
| See the tables and their constraints         | [database schema](docs/database-schema.md)                       |
| Understand logs, traces and metrics          | [observability](docs/observability.md)                           |
| Check what CI runs                           | [continuous integration](docs/continuous-integration.md)         |
| Check how it is deployed                     | [deployment pipeline](docs/deployment-pipeline.md)               |
| Use or tear down the live deployment         | [hosted demonstration](docs/hosted-demonstration.md)             |
| See what is actually proven                  | [acceptance evidence](docs/acceptance-evidence.md)               |
| Look up a business term                      | [CONTEXT.md](CONTEXT.md)                                         |

## Limitations and next steps

These are known gaps, not completed work. The acceptance evidence for the current revision is in [docs/acceptance-evidence.md](docs/acceptance-evidence.md).

- **A hosted deployment is live**, and it is disposable. Cloudflare Workers with PlanetScale Postgres through Hyperdrive is the first hosted target ([ADR 0005](docs/adr/0005-cloudflare-first-deployment.md)): the Hyperdrive design (#28), then the deployment pipeline (#15), then the hosted demonstration (#33). The API runs at **https://scos-api.bonanaaaaaa-scos.workers.dev** — access, resource inventory, cost, known limitations and teardown are in [hosted demonstration](docs/hosted-demonstration.md). Two things to know before using it: it is **public and unauthenticated**, and its stock is **finite and never replenished**, so every submitted order permanently consumes part of the demonstration. `Deploy Prod` (`deploy-prod.yml`, which calls the shared `deploy.yml`) runs on every merge to `main` with no approval, and the PlanetScale database bills from creation until it is deleted.
- **AWS Lambda is deferred** (#14). The per-endpoint apps and the Lambda notes in [apps/api/README.md](apps/api/README.md#notes-for-lambda-deployment-14-deferred) are kept for when it resumes, but no Lambda handler or packaging exists yet.
- **No authentication or access control.** Any client that can reach the API can verify and submit orders. A `submissionId` is a retry key, not a credential.
- **Hosted-only checks are not verified.** They need a real Cloudflare account and are listed in [Workers limitations](docs/observability.md#workers-limitations) and [Limitations](docs/observability.md#limitations):
  - Hyperdrive transaction-mode pooling, including that the submission transaction's transaction-local timeouts carry over and nothing relies on session state;
  - Hyperdrive query caching staying disabled, so inventory reads are never stale;
  - the telemetry flush and per-request pool close under `ctx.waitUntil`, and a deployed Worker with its collector down logging only export warnings;
  - Workers Logs and Logpush ingestion, CPU time on the Free plan with a Prisma client per request, and replacing the placeholder Hyperdrive ID.
- **No latency or throughput targets are agreed.** Measurements are reported as observed, without pass/fail targets.
- **A silent established database connection is not bounded** until the operating system reports it broken, because TCP keepalive is not configured ([database timeouts](apps/api/README.md#database-timeouts)).
