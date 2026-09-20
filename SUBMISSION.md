# Submission summary

The challenge: a backend for the ScreenCloud order management system — verify an
order without submitting it, submit an order that immediately consumes warehouse
stock, price it with volume discounts and distance-based shipping, and reject it
when shipping exceeds 15% of the discounted amount.

This file maps each requirement in the brief to the code, document or URL that
satisfies it, then explains the decisions behind them. Everything it claims is
either in this repository or reachable at the hosted URL.

- **Run it locally:** [README, evaluator walkthrough](README.md#evaluator-walkthrough)
- **Run it hosted:** <https://scos-api.bonanaaaaaa-scos.workers.dev/docs> — public,
  unauthenticated, and its stock is finite and never replenished
- **Evidence for every acceptance claim:** [docs/acceptance-evidence.md](docs/acceptance-evidence.md)

---

## 1. Requirement coverage

### Functional requirements

| Requirement                                                                                                    | Where it lives                                                                                                                                                                                                       | Status |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| A sales rep can verify a potential order without submitting it, by quantity and destination latitude/longitude | `POST /api/v1/orders/verify` — [`apps/api/src/endpoints/verify-order/`](apps/api/src/endpoints/verify-order), [`packages/core/src/application/verify-order.ts`](packages/core/src/application/verify-order.ts)       | Done   |
| The response shows total price, discount and shipping cost                                                     | [`estimateOrder`](packages/core/src/domain/ordering/estimate.ts) returns subtotal, discount rate, discount amount, discounted total, shipping cost and order total                                                   | Done   |
| The response indicates the order's validity                                                                    | Estimate is one of `VALID`, `SHIPPING_EXCEEDS_LIMIT` or `INSUFFICIENT_STOCK`; the first two carry every amount, the third nulls shipping and total                                                                   | Done   |
| A sales rep can submit an order by quantity and destination                                                    | `POST /api/v1/orders` — [`apps/api/src/endpoints/submit-order/`](apps/api/src/endpoints/submit-order), [`packages/core/src/application/submit-order.ts`](packages/core/src/application/submit-order.ts)              | Done   |
| A successful submission immediately updates warehouse inventory                                                | One PostgreSQL transaction locks the warehouse rows, re-evaluates against current stock, writes the order and its allocations, and deducts stock together — [ADR 0004](docs/adr/0004-deduplicate-accepted-orders.md) | Done   |
| The order has an order number                                                                                  | [`order-number.ts`](packages/core/src/domain/ordering/order-number.ts); persisted on the order row                                                                                                                   | Done   |
| The order stores total price, discount and shipping cost as calculated at submission time                      | Amounts are frozen onto the order row inside the same transaction, never recomputed on read — [ADR 0001](docs/adr/0001-advisory-verification.md)                                                                     | Done   |

**Pricing and shipping rules, as implemented**

```text
subtotal   = 150 * quantity
discount   = subtotal * rate
discounted = subtotal - discount

rate = 0% below 25 units, 5% at 25+, 10% at 50+, 15% at 100+, 20% at 250+

for each warehouse in the plan:
  cost     = units * 0.365 kg * 0.01 per kg per km * distance_km
shipping   = round(sum of those costs, 2 decimals)

total      = discounted + shipping

valid      when every unit is allocated
           and shipping <= 0.15 * discounted
```

For example, 150 units to Berlin served from Warsaw (515 km): subtotal
`150 * 150 = 22500.00`, discount `22500 * 0.15 = 3375.00`, discounted
`19125.00`, shipping `150 * 0.365 * 0.01 * 515 = 281.96`, total `19406.96`.
Shipping is 1.5% of the discounted total, well inside the 15% limit.

`distance_km` is the great-circle (Haversine) distance from the warehouse to
the destination, on a sphere of radius 6 371.0088 km (the IUGG mean radius R1
of GRS80) — [`distance.ts`](packages/core/src/domain/shipping/distance.ts).

**Multi-warehouse allocation at lowest cost.** An order is filled nearest-first
across the six warehouses, each taking `min(remaining, available)`, with ties
broken by warehouse ID so the plan is deterministic. This is not a heuristic: a
unit's cost is linear in its warehouse's distance at an identical rate, so moving
any unit to a farther warehouse can only raise the total. Nearest-first greedy is
therefore the provably least-cost complete allocation —
[`allocation.ts`](packages/core/src/domain/shipping/allocation.ts).

### Technical requirements

| Requirement                                                                              | How it is met                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Implemented in TypeScript                                                                | Whole repository. Strict TypeScript across a pnpm + Turbo monorepo: [`packages/core`](packages/core) (domain and use cases), [`packages/persistence`](packages/persistence) (Prisma), [`apps/api`](apps/api) (Hono), [`apps/api-acceptance`](apps/api-acceptance) (Playwright)                    |
| Stores data in a database                                                                | PostgreSQL through Prisma. Normalized schema for warehouses, orders and allocations, with migrations and a reproducible six-warehouse seed — [docs/database-schema.md](docs/database-schema.md), which opens with the [entity-relationship diagram](docs/database-schema.md#entity-relationships) |
| Exposes its capabilities through a well-documented API                                   | OpenAPI 3.1 generated from the route contracts and served at `GET /openapi.json`, with Swagger UI at `GET /docs`. The specification is generated at build time and never committed; CI asserts real responses conform to the served document                                                      |
| A clear testing strategy is demonstrated                                                 | Four levels, described in [§4](#4-testing-strategy)                                                                                                                                                                                                                                               |
| No opinionated application framework                                                     | Hono, deliberately, rather than NestJS. Business rules live in a framework-independent core; Hono is a driving adapter over it — [docs/architecture.md](docs/architecture.md)                                                                                                                     |
| Approached as a production system (performance, scalability, consistency, extensibility) | Row-locked submission transaction, idempotent submission, exact decimal arithmetic, OpenTelemetry logs/traces/metrics, bounded database timeouts, hexagonal boundaries — [§3](#3-key-decisions-and-trade-offs)                                                                                    |
| Trivial to start and test locally                                                        | One walkthrough from a fresh checkout: `pnpm install`, `docker compose up`, migrate, seed, start — [README](README.md#evaluator-walkthrough)                                                                                                                                                      |
| Cloud deployment and CI/CD (a plus)                                                      | Live on Cloudflare Workers with PlanetScale Postgres through Hyperdrive, provisioned by Terraform and deployed by GitHub Actions on every merge to `main` — [§2](#2-how-to-run-it) and [docs/hosted-demonstration.md](docs/hosted-demonstration.md)                                               |

### Submission requirements

| Requirement                                                    | Status                                                                                                                            |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Public GitHub repository                                       | This repository                                                                                                                   |
| README states what I would do next if this were a real project | [README, Limitations and next steps](README.md#limitations-and-next-steps), summarized in [§5](#5-known-gaps-and-what-id-do-next) |

---

## 2. How to run it

### Hosted, in about a minute

```sh
base=https://scos-api.bonanaaaaaa-scos.workers.dev

curl -s "$base/health"

# Verify — advisory, writes nothing, consumes nothing.
curl -s -X POST "$base/api/v1/orders/verify" \
  -H 'content-type: application/json' \
  -d '{"quantity":150,"latitude":52.52,"longitude":13.405}'
```

Swagger UI with "Try it out" enabled is at
<https://scos-api.bonanaaaaaa-scos.workers.dev/docs>.

Two things to know before submitting an order there: the API is **public and
unauthenticated**, and the demonstration's stock is **finite and never
replenished**, so every submission permanently consumes part of it. Access,
resource inventory, cost and teardown are in
[docs/hosted-demonstration.md](docs/hosted-demonstration.md).

### Locally

Node.js 24.15.0, pnpm and Docker; host ports 5432, 5433 and 3000 free. The
[evaluator walkthrough](README.md#evaluator-walkthrough) is the authoritative
version — install, start the development and disposable test databases, migrate,
seed the six warehouses, build, and serve on <http://localhost:3000>.

---

## 3. Key decisions and trade-offs

Each of these is recorded as an ADR; the summaries below are the short form.

### Verification is advisory; submission is authoritative — [ADR 0001](docs/adr/0001-advisory-verification.md)

Stock can move between the moment a rep verifies an order and the moment they
submit it. Verification therefore reserves nothing and promises nothing: it is a
snapshot estimate. Submission recalculates against current inventory and consumes
stock atomically.

_The trade-off:_ a previously valid estimate can become more expensive, or
invalid, by the time it is submitted. The alternative — a reservation with a
lifecycle, expiry and release — is a much larger system, and the brief asks for
submission-time amounts, not held stock. Advisory verification is the honest
model for what the brief describes.

The [verification and submission sequence](docs/design-decisions.md#verification-and-submission-sequence)
diagram shows this end to end: the advisory estimate that reserves nothing,
another rep consuming stock in between, and the single transaction that locks
the warehouse rows, recalculates and commits.

### Submission is idempotent by client key — [ADR 0004](docs/adr/0004-deduplicate-accepted-orders.md)

A double-clicked button or a retry after a lost response must not create a second
order or consume stock twice. `POST /api/v1/orders` takes a required
client-generated `submissionId`, stored as a unique `submission_key` on the
accepted order row. Inside the submission transaction, after the warehouse rows
are locked: the same key with the same inputs replays the original order without
recalculating or deducting; the same key with different inputs is a conflict; a
new key is evaluated normally. The unique index is the backstop.

_The trade-off:_ only accepted orders are deduplicated. Rejections are not stored
or replayed, so retrying a rejected attempt re-evaluates it against inventory that
may have changed. This replaced an earlier design that persisted every outcome
([ADR 0002](docs/adr/0002-replay-submission-outcomes.md), superseded) — that
bought outcome stability at the cost of extra tables the brief never asked for.
A `submissionId` is a retry key, not a credential.

### Money is exact; no floating point anywhere in an amount

With a $150 unit price and whole-percent discount rates, every discount is a whole
multiple of $0.05, so every amount is exact at cent scale. `Money` asserts that
rather than rounding it away
([`money.ts`](packages/core/src/domain/shared/money.ts),
[`pricing.ts`](packages/core/src/domain/pricing/pricing.ts)). Shipping is the one
place a rounding rule is needed, because distance is irrational: it is
round-half-up to 2 decimal places, applied once to the summed cost. Amounts are
stored as `NUMERIC(12, 2)`; an estimate whose total would overflow that is a
server error, not a silently wrong number.

### Hexagonal boundaries, so the runtime is a detail — [docs/architecture.md](docs/architecture.md)

`packages/core` holds the domain and use cases and depends on nothing but Zod.
Persistence and HTTP are adapters behind ports
([`inventory-reader.ts`](packages/core/src/application/ports/inventory-reader.ts),
[`submission-store.ts`](packages/core/src/application/ports/submission-store.ts)).
The [architecture diagram](docs/architecture.md) shows the whole shape — what
calls in, what is called out, and which way every arrow points — and the
[domain model](docs/architecture.md#domain-model) shows the aggregate, value
objects and domain services inside the core. The
[repository map](docs/architecture.md#repository-map) places every directory in
that picture and says which document answers which question.

This paid for itself: moving the hosted target from AWS Lambda to Cloudflare
Workers changed an entry point and some infrastructure and touched no business
rule at all.

### Cloudflare Workers first, AWS Lambda deferred — [ADR 0005](docs/adr/0005-cloudflare-first-deployment.md)

The original plan was one Lambda per endpoint behind RDS Proxy. An AWS account
issue blocked that before the deadline, so the demonstration ships on Cloudflare
Workers with PlanetScale Postgres through Hyperdrive. Consequences worth naming:
the database client is created **per request** inside the handler, because
Workers forbids reusing I/O objects across requests — the exact opposite of the
Lambda guidance; Hyperdrive pools in **transaction mode**, so lock and statement
timeouts are set inside each transaction and nothing relies on session state; and
Hyperdrive **query caching is disabled**, because it does not invalidate on write
and a cached inventory read could return stale stock.

The Lambda design is deferred, not deleted — it is still in
[apps/api/README.md](apps/api/README.md) for when that track resumes.

### Observability is built in, not bolted on

OpenTelemetry-aligned structured logs, traces and metrics, with the deployed
Worker traced through Cloudflare's automatic tracing —
[docs/observability.md](docs/observability.md).

---

## 4. Testing strategy

The brief asks for a clear strategy rather than exhaustive coverage. The strategy
is that **each level tests one thing, and each package tests itself**; there is no
combined core-plus-persistence level, and the full stack is tested through the
API.

| Level                                         | Where                                                                                  | What it proves                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Domain and use-case unit tests**            | 15 files beside the code in `packages/core/src`                                        | Pricing tiers, Haversine distance, nearest-first allocation, the 15% validity rule, order-number and submission-key invariants, exact-money assertions. No database, no HTTP                                                                                                                                   |
| **Adapter unit tests**                        | 9 in `packages/persistence/src`, 42 in `apps/api/src`                                  | Route contracts, request validation, error mapping, OpenAPI shapes, telemetry records                                                                                                                                                                                                                          |
| **Integration tests against real PostgreSQL** | 6 in `packages/persistence/test`, 7 in `apps/api/test`, plus a Worker suite in workerd | Connectivity, migrations, schema, seed, the inventory reader, and full-stack ordering through the composed API — including the row-locked submission transaction and the duplicate-submission path                                                                                                             |
| **Acceptance tests against the served API**   | 9 Playwright specs in `apps/api-acceptance`                                            | The built API running as a real process over HTTP: the P1 scenarios, and OpenAPI conformance — the served document is valid OpenAPI 3.1, real responses conform to its schemas, and `dist/openapi.json` equals the served `/openapi.json`. The same suite runs against the hosted deployment via `test:hosted` |

Two guards keep the suite honest: CI fails if any integration or acceptance test
uses `.skip`, `.only`, `.todo`, `.fixme` or `.fail`, and the database integration
task is never Turbo-cached.

```sh
pnpm test              # unit, every package, with coverage
pnpm test:integration  # against real PostgreSQL
pnpm test:acceptance   # Playwright against the served API
```

**Continuous integration** (`.github/workflows/`): `CI` runs workspace build,
typecheck, Oxlint, Oxfmt, tests and coverage, plus the PostgreSQL integration job;
`Acceptance` runs the Playwright suite and uploads JUnit and HTML reports;
`Actionlint`, `PR Title` and `Code Scanner` (verified-secret scanning) police the
repository; `Infrastructure checks` runs Terraform validation and shell tests.

**Continuous delivery:** `Deploy Prod` runs on every merge to `main` with no
approval gate, calling the shared `deploy.yml` to migrate PlanetScale and deploy
the Worker.

---

## 5. Known gaps and what I'd do next

Stated plainly, because these are gaps rather than completed work. The fuller
list is in [README, Limitations and next steps](README.md#limitations-and-next-steps).

**Would do first, if this were real:**

1. **Authentication and access control.** There is none. Any client that can
   reach the API can verify and submit orders. A real system needs sales-rep
   identity on every order, and the hosted demonstration should not be open.
2. **An approval gate on production deploys.** `Deploy Prod` currently ships
   every merge to `main` unreviewed — fine for a disposable demonstration,
   wrong for a system that moves inventory.
3. **Agreed latency and throughput targets.** Measurements are currently
   reported as observed, with no pass/fail threshold to regress against.
4. **Stock replenishment and inventory adjustments.** The brief only consumes
   stock. A real warehouse system needs restocking, transfers and corrections,
   which in turn means an inventory ledger rather than a mutable counter.

**What remains.** The core is complete and verified, and the hosted
demonstration is live and verified from the outside
([evidence](docs/hosted-demonstration.md#verification-evidence)). None of what
is left is unfinished business logic:

- **The second cloud target is deliberately postponed.** An AWS account issue
  stopped the Lambda track before the deadline
  ([ADR 0005](docs/adr/0005-cloudflare-first-deployment.md)). The design and
  the per-endpoint composition roots are kept, but no Lambda handler or
  packaging exists.
