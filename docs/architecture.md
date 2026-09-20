# Architecture

SCOS uses hexagonal architecture (ports and adapters, Alistair Cockburn) for
the structure, and domain-driven design (DDD) for the model inside it. The
business rules sit in the middle. Everything technical, such as HTTP, the
database and the hosting runtime, is a replaceable attachment on the outside. The hexagon
shape has no meaning of its own; it is drawn with many sides because an
application can have many plugs.

```mermaid
flowchart LR
    subgraph driving["Driving adapters (call in)"]
        api["Hono HTTP API<br/>apps/api"]
        worker["Cloudflare Worker<br/>apps/api (workerd)"]
        lambda["Lambda handler<br/>(deferred, #14)"]
    end

    subgraph core["packages/core"]
        direction TB
        app["application/<br/>VerifyOrder, SubmitOrder<br/>(orchestration)"]
        ports["application/ports<br/>InventoryReader, SubmissionStore,<br/>SubmissionTransaction<br/>(interfaces)"]
        domain["domain/<br/>Money, Quantity, Destination, pricing,<br/>distance, allocation, estimate, Order<br/>(pure rules)"]
        app --> domain
        app --> ports
    end

    subgraph driven["Driven adapters (called out)"]
        db["Prisma / PostgreSQL<br/>packages/persistence"]
    end

    api --> app
    worker --> app
    lambda --> app
    db -. implements .-> ports
```

## Repository map

Where each directory sits in the diagram above. The rule of thumb: `packages/`
holds what the business would still need if every technology changed, `apps/`
and `infra/` hold the technologies.

| Directory                | What it is                                                                                                                                           | Hexagon position    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `packages/core`          | The domain model and the use cases, with the ports they need. Depends on nothing but Zod — [README](../packages/core/README.md)                      | The hexagon         |
| `packages/persistence`   | Prisma schema, migrations, the six-warehouse seed, and the driven adapters that implement core's ports — [README](../packages/persistence/README.md) | Driven adapter      |
| `apps/api`               | The Hono API: routes, request schemas, OpenAPI, telemetry, and the Node and Worker entry points — [README](../apps/api/README.md)                    | Driving adapter     |
| `apps/api-acceptance`    | The QA-owned Playwright suite. Imports no API source; talks to a running server only over HTTP — [README](../apps/api-acceptance/README.md)          | Outside the hexagon |
| `infra/cloudflare`       | Terraform for the Worker, Hyperdrive and secrets, plus the deploy scripts and their tests                                                            | Infrastructure      |
| `infra/planetscale`      | The one-shot database bootstrap script and its tests                                                                                                 | Infrastructure      |
| `libs/typescript-config` | The shared `tsconfig` base every package extends                                                                                                     | Tooling             |
| `scripts`                | Repository scripts with their own tests: PR-title validation, hosted concurrency measurement                                                         | Tooling             |
| `docs`                   | The written record — see the table below                                                                                                             | —                   |

Two splits are deliberate and easy to miss:

- **`apps/api` vs `apps/api-acceptance`.** `apps/api` holds the developer tests,
  which compose the application inside the test process. `apps/api-acceptance`
  holds the QA suite, which starts the built artifact as a real server and only
  speaks HTTP to it. The second cannot accidentally pass because of a test
  double, which is the whole point of keeping it separate.
- **`packages/persistence/src` vs `packages/persistence/test`.** `src` holds
  unit tests beside their code; `test` holds the tests that need a real
  PostgreSQL, so CI can run them as a separate, never-cached job.

### Which document answers which question

| I want to know…                                         | Read                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How do I run it, locally or hosted?                     | [README](../README.md#evaluator-walkthrough)                                                                                                                                                                                                                                                                                                       |
| What does the challenge ask, and where is it?           | [SUBMISSION.md](../SUBMISSION.md)                                                                                                                                                                                                                                                                                                                  |
| What do these business words mean?                      | [CONTEXT.md](../CONTEXT.md)                                                                                                                                                                                                                                                                                                                        |
| How is the code structured, and where does new code go? | This file                                                                                                                                                                                                                                                                                                                                          |
| Why is it built this way?                               | [ADRs](adr/) — [0001](adr/0001-advisory-verification.md) advisory verification, [0003](adr/0003-database-managed-timestamps.md) timestamps, [0004](adr/0004-deduplicate-accepted-orders.md) idempotent submission, [0005](adr/0005-cloudflare-first-deployment.md) Cloudflare first ([0002](adr/0002-replay-submission-outcomes.md) is superseded) |
| What was agreed before implementation?                  | [PRD](prd/scos-ordering.md), [design decisions](design-decisions.md)                                                                                                                                                                                                                                                                               |
| What do the tables look like?                           | [database schema](database-schema.md)                                                                                                                                                                                                                                                                                                              |
| What do logs, traces and metrics do?                    | [observability](observability.md)                                                                                                                                                                                                                                                                                                                  |
| How is it deployed?                                     | [deployment pipeline](deployment-pipeline.md), [Cloudflare design](cloudflare-deployment-design.md), [PlanetScale bootstrap](planetscale-bootstrap.md)                                                                                                                                                                                             |
| What is actually proven, and what is not?               | [acceptance evidence](acceptance-evidence.md), [hosted demonstration](hosted-demonstration.md)                                                                                                                                                                                                                                                     |

## Layers

1. **Domain** (`packages/core/src/domain`) holds the business rules: volume
   discounts, the 15% shipping limit, nearest-warehouse allocation, exact money,
   and the Order aggregate. It consists of pure functions and value objects,
   with no I/O, no ports, and no knowledge of HTTP or databases.
2. **Application** (`packages/core/src/application`) has one use case per thing
   a caller can do: verify an order (`createVerifyOrder`) and submit an order
   (`createSubmitOrder`). A use case coordinates: it loads
   data, calls the domain, and saves the result. It needs outside data but must
   not know how it is stored, so it declares what it needs as ports. See
   [Application layer](#application-layer).
3. **Ports** are interfaces owned by core, for example "give me the inventory
   snapshot" or "within one transaction, lock stock, find the Order already
   stored for this submission key, or save the new order". Core defines their shape and never implements
   them.
4. **Adapters** are the plugs on the outside.
   - **Driving adapters** call into the application. The Hono API validates
     the HTTP request with Zod, turns it into a use-case call and maps the typed
     outcome to a status code (200, 201, 400, 409, 422, 500 or 503; 404 for
     unknown routes). The order endpoints are `POST /api/v1/orders/verify` and
     `POST /api/v1/orders` (the `API_PREFIX` constant); `GET /health` stays at
     the root. See [apps/api/README.md](../apps/api/README.md) for the
     contract. Each endpoint is its own Hono app with its own composition
     (`createHealthApp`, `createVerifyOrderApp`, `createSubmitOrderApp`), which
     builds only the adapters that endpoint needs, so each can be deployed as a
     separate Lambda function. Each lives in its own folder,
     `apps/api/src/endpoints/{health,verify-order,submit-order}/`, with its
     contract, app, composition, configuration and tests; shared HTTP pieces
     (error envelope, JSON handling, shared schemas) are in `src/http/`, which
     never imports an endpoint, and endpoints never import each other.
     `createApp` (`src/app.ts`) mounts all three for the local server and the
     API documentation. The first hosted deployment is a Cloudflare Worker
     (#28) that serves the combined app; see
     [ADR 0005](adr/0005-cloudflare-first-deployment.md). Lambda handlers
     (#14, deferred) are a further driving adapter over the same per-endpoint
     apps.
   - **Worker connections (#28):** the hosted Worker reaches PlanetScale
     Postgres through Cloudflare Hyperdrive, which pools in transaction mode
     (the per-request client is described under **Cloudflare Worker** below).
     The submission transaction already sets its timeouts with
     `set_config(..., true)`, which is transaction-local and so survives
     Hyperdrive resetting pooled connections. #28 confirmed that, and that
     nothing relies on session state, against a simulated transaction pooler;
     #33 checks it through a real Hyperdrive. Hyperdrive query caching stays
     disabled so inventory reads are never stale. See the
     [Cloudflare deployment design](cloudflare-deployment-design.md).
   - **Lambda connections (#14, deferred):** each Lambda execution environment has its
     own in-process pg pool and serves one request at a time. Nothing sets the
     pool size yet (pg defaults to 10); the recommendation is for #14 to apply
     and verify `max: 1` per environment. RDS Proxy, the chosen connection
     approach, pools connections across all per-endpoint functions and bounds
     those reaching PostgreSQL. #14 must check whether the transaction's
     `set_config(..., true)` calls pin the client connection, and whether
     pg/Prisma prepared statements do; verify IAM or Secrets Manager
     authentication; and compare proxy timeouts with the 5 s connect timeout.
   - **Telemetry** is adapter code in `apps/api`: spans come from a Hono
     middleware and decorators around the use cases and ports, applied in the
     compositions, behind runtime-neutral ports. Core and persistence have no
     OpenTelemetry dependency. The Node/Lambda and Cloudflare Workers
     compositions wire the same ports with their own SDK setup. See
     [observability.md](observability.md).
   - **Cloudflare Worker** (`src/entrypoints/worker.ts`,
     `src/composition/worker.ts`): a third driving adapter over the same
     `createApp`, use cases and persistence adapters. It reaches PostgreSQL
     through a Hyperdrive binding and opens a pool and Prisma client per
     request (Workers forbid sharing sockets across requests). It uses
     `@scos/persistence`'s `workerd` build, which is the same adapters over a
     Prisma client generated for workerd. The Hyperdrive design is #28
     ([design record](cloudflare-deployment-design.md)), the
     deployment pipeline is #15, and the hosted demonstration is #33.
   - **Driven adapters** are called by the application. `packages/persistence`
     implements the ports with Prisma and SQL.

## The dependency rule

Dependencies point inward only:

- Adapters depend on core. Core never imports Hono, Prisma, `pg` or
  `@scos/persistence`.
- Inside core, `application/` depends on `domain/`, never the reverse.
- The `no-restricted-imports` rule in `packages/core/.oxlintrc.json` enforces
  both for every file under `packages/core/src`.
- Adapters import only the package root (`@scos/core`), not internal files.
- Imports are never relative; see [Module specifiers](#module-specifiers).

The database is reached through dependency inversion. The use case needs
persistence, but instead of importing it, core declares a port and
`packages/persistence` implements it. The composition roots in `apps/api`
(`src/endpoints/<name>/composition.ts` per endpoint, and `src/composition/node.ts`
for the combined app) wire the adapter into the use case at startup, after the
runtime entry point (`src/entrypoints/node.ts` locally) has validated the environment.

## Module specifiers

No import leaves its own folder relatively. A file names its folder mates
relatively (`./contract`); every other module is named by the workspace
package that exports it or by the importing package's own `imports` map in
`package.json`:

| Target                               | Specifier                         | Example                  |
| ------------------------------------ | --------------------------------- | ------------------------ |
| A file in the same folder            | `./<file>`                        | `./contract`             |
| Another workspace package            | its package name, root entry only | `@scos/core`             |
| A file in the same package's `src/`  | `#<path under src>`               | `#domain/shared/money`   |
| A file in the same package's `test/` | `#test/<path under test>`         | `#test/support/database` |

The maps are small and mechanical; `apps/api`, for example, declares:

```json
"imports": {
  "#*": "./src/*.ts",
  "#test/*": "./test/*.ts"
}
```

Each target carries the `.ts` extension, so every tool resolves a specifier to
exactly one file with no extension guessing: `tsc`, Vitest (Node and the
workerd pool), `tsx`, esbuild (the Node bundle and Wrangler's Worker bundle)
and tsdown all read `imports` from `package.json` natively, so no path
aliases, resolver plugins or per-tool configuration are needed.
`packages/persistence` reaches the generated Prisma clients the same way
(`#generated/prisma/client`); its workerd build redirects that one specifier
to `#generated/prisma-workerd/client` (`tsdown.config.ts`).

Two `no-restricted-imports` patterns in `.oxlintrc.json` hold the line: one
rejects a `..` segment anywhere in a specifier (`../x`, and `./../x`, which
reaches the same file), the other rejects a descendant such as `./sub/x`. What
is left is exactly the folder mate. `packages/core/.oxlintrc.json` replaces the
root configuration for that package, so it repeats both next to the layering
rules below. Tool configuration and build scripts (`vitest.*.mjs`,
`*.config.mjs`, `build.mjs`) are exempt: their tool loads them by path, outside
the module graph.

Because a relative import cannot leave its folder, it can never cross a layer
or a package boundary, so the layering rules below and the rule that adapters
import only `@scos/core`'s root are unaffected by the exception: every
specifier that reaches another folder is still absolute.

Import order is part of the format rather than a review topic: Oxfmt sorts
every import list (`sortImports` in `.oxfmtrc.json`) into Node built-ins, then
packages, then this package's own `#...` modules, then folder mates, each group
alphabetical and separated by a blank line. Side-effect imports keep their position, because
for them the order is the meaning.

What this buys us: outside its own folder a module has exactly one name, so a
specifier says where code lives rather than how far away it is, and finding
every importer of a module is a plain search; moving a file changes only its
own path, never the `../../..` chains of the files that import it; a cohesive
folder still reads without repeating its own name in every line of its
imports; and nothing can reach into another package's internals, because a
package's files are addressable only from inside it.

## Where does code go?

Ask whether the code would still be true if HTTP were replaced by a CLI and
PostgreSQL by a spreadsheet:

| Answer                                                  | Layer                 | Examples                                                                       |
| ------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------ |
| Yes, and it is a rule                                   | Domain                | discount tiers, allocation, shipping limit, Order invariants                   |
| Yes, but it is a sequence of steps needing outside data | Use case, plus a port | lock stock, then allocate, then save; return the Order that has the same key   |
| No, it is about a specific technology                   | Adapter               | SQL and row locking, HTTP status codes, Zod request schemas for HTTP, env vars |

For example, warehouse allocation is domain code, not a use case. It applies
business rules (nearest first, stable ID ties, never above stock, no partial
fulfillment) to an in-memory snapshot, has no side effects, and must behave
identically for verification and submission. The use cases decide when to
allocate and with which data; the domain decides how.

## What this buys us

- **Testing:** domain tests are plain unit tests without mocks or a database.
  Use cases can be tested with in-memory fake ports. Only adapters need a real
  PostgreSQL, which the integration tests provide.
- **Swapping technology:** running on a Cloudflare Worker or on Lambda instead
  of a local server means adding a driving adapter, not rewriting logic. Changing the database means
  rewriting one adapter.
- **Clear ownership:** rules in [design decisions](design-decisions.md) such as
  "Prisma types stay outside the domain" and "persist accepted Orders as
  snapshots, not HTTP status codes" are this architecture written down. Only
  accepted Orders are stored ([ADR 0004](adr/0004-deduplicate-accepted-orders.md)):
  a repeated submission is matched by the Order's submission key, rejections
  are not stored, and HTTP statuses are never persisted.

## Application layer

```text
packages/core/src/application/
  verify-order.ts            createVerifyOrder: the VerifyOrder use case
  submit-order.ts            createSubmitOrder: the SubmitOrder use case
  ports/inventory-reader.ts  InventoryReader: driven port for reading stock
  ports/submission-store.ts  SubmissionStore: driven port for one submission transaction
```

**VerifyOrder** answers "what would this Order Request cost right now, and
could it be accepted?". `createVerifyOrder({ inventoryReader })` returns a
function `(request: OrderRequest) => Promise<OrderEstimate>` that:

1. reads one inventory snapshot through the `InventoryReader` port, exactly once
   per call and with nothing cached between calls;
2. passes it to the domain's `estimateOrder`, the same calculation submission
   will use, and returns that Order Estimate unchanged.

The result is a typed outcome, not an HTTP response: a valid estimate, or
`valid: false` with reason `SHIPPING_EXCEEDS_LIMIT` (all amounts and Warehouse
Allocations kept) or `INSUFFICIENT_STOCK` (merchandise and discount amounts
kept, no allocations, `null` shipping cost and order total). Business rejections
are returned; only port failures and `DomainError` reject the promise. Mapping
to status codes belongs to the HTTP adapter.

The estimate is advisory ([ADR 0001](adr/0001-advisory-verification.md)).
Verification creates no Order, reserves and deducts no stock, and writes
nothing, so it does not promise later acceptance: a repeated verification sees
whatever stock is current, and submission recalculates from the stock it locks.

**`InventoryReader`** is the port: `readInventorySnapshot()` resolves to one
coherent, complete, point-in-time `InventorySnapshot`, read-only and without
locks. `createPrismaInventoryReader` in `packages/persistence` implements it
with a single `SELECT` over `warehouses`. One statement sees one MVCC snapshot,
so the stock values are mutually consistent without a transaction (see
[Read pattern for verification](database-schema.md#read-pattern-for-verification-9)).
The composition root wires the two together:

```ts
const verifyOrder = createVerifyOrder({
  inventoryReader: createPrismaInventoryReader(prisma),
});
```

**SubmitOrder** uses its own port, `SubmissionStore`, not `InventoryReader`.
Within one transaction it locks every warehouse row, finds any Order already
stored under the submission key, and saves a new Order while deducting stock
(ADR 0004). It recalculates with the same `estimateOrder`, so a verified
estimate can cost more or be rejected at submission.

## Hexagonal architecture and DDD

The two are separate ideas that fit together. Hexagonal architecture decides
where the boundaries go. DDD decides how to model what is inside: value objects
(`Money`, `Quantity`, `Destination`), aggregates (`Order`) and domain services
(pricing, allocation). The project uses one bounded context, Ordering; its
vocabulary is in [CONTEXT.md](../CONTEXT.md).

## Domain model

The domain layer (`packages/core/src/domain`) models the Ordering context with
one aggregate, a set of value objects and a few stateless domain services.
Solid diamonds are composition (the owner holds the value); dashed arrows are
"uses" or "returns" dependencies of a function.

![The SCOS Ordering domain model](images/domain-model.svg)

- **Aggregate root: `Order`.** An accepted order with its identity (`id`,
  `orderNumber`), the client's `submissionKey`, amounts and allocations. A new
  Order is built only by the `createOrder` factory, which accepts only a valid
  `OrderEstimate` and re-verifies every invariant (quantity range, allocations
  summing to the quantity, subtotal, discount tier and amount, shipping cost and
  the 15% limit, order total) before returning a frozen `NewOrder`; a violation
  throws `DomainError`. The database assigns the `id` on insert. A stored Order
  is rebuilt with `restoreOrder`, which checks structure and derived totals but
  not current commercial rules, because accepted amounts are historical facts.
  An Order's allocations (`OrderAllocation`) keep only the warehouse and
  quantity, the facts that are stored, so a rebuilt Order equals the one
  returned at acceptance. The order number is `SO-` plus 12 random Crockford
  base32 characters (see [database schema](database-schema.md#identifiers-and-keys)).
- **Value objects** have no identity and are immutable: `Quantity`,
  `Destination` and `SubmissionKey` (branded, produced by the Zod input
  schemas), `Money`,
  `DiscountRate`, `WarehouseAllocation`, `ShippingPlan` (a non-empty list of
  allocations), `OrderRequest` and `OrderEstimate`. An estimate carries the
  request's quantity and destination, the priced amounts, and either a
  `ShippingPlan` or a rejection `reason`. `SubmissionKey` is the client's retry
  key, stored verbatim as the accepted Order's unique `submission_key`; it is
  not part of what is ordered, so it is not in `OrderRequest`.
- **Domain services** are stateless functions: pricing (discount tiers,
  merchandise totals), shipping (combined cost rounded once, exact 15% limit),
  allocation (nearest-first; it returns no plan when stock is insufficient) and
  distance (Haversine). `estimateOrder` composes them into an estimate.

What is deliberately absent:

- **No `Warehouse` entity.** Core never owns or changes warehouses; it only reads
  an `InventorySnapshot` (a list of `WarehouseStock` rows) that a use case loads
  through a port and passes in. Reserving stock is the persistence adapter's job.
- **Estimates have no identity and no repository.** They are recomputed on
  demand and never stored; only an accepted `Order` is persisted.
- **No domain events yet.** Nothing inside the context reacts to an order being
  accepted, so there is nothing to publish.
- **One bounded context, Ordering.** Its terms (Order Request, Order Estimate,
  Warehouse Allocation, Shipping Plan and so on) are defined in
  [CONTEXT.md](../CONTEXT.md).

### Folder layout by concept

```text
packages/core/src/domain/
  shared/    decimal, money, errors, product constants, quantity, destination
  pricing/   discount tiers and merchandise pricing
  shipping/  distance, nearest-first allocation, shipping cost and limit
  ordering/  order request schema, estimateOrder, the Order aggregate
```

Dependencies point one way: `shared` <- `pricing`, `shipping` <- `ordering`.
`shared` imports no other domain folder, `pricing` and `shipping` do not import
each other or `ordering`, and `ordering` may import all of them. No domain file
imports `application/`. `packages/core/.oxlintrc.json` enforces these rules with
`no-restricted-imports`, alongside the ban on adapter technology imports and
the repository-wide ban on relative imports.

The folders follow domain concepts rather than DDD building-block types
(`entities/`, `value-objects/`, `services/`). Code that changes together stays
together: a new discount tier touches only `pricing/`, and a new shipping rate
only `shipping/`. The folder names also match the words in CONTEXT.md, so a
reader can go from a business term straight to its code.
