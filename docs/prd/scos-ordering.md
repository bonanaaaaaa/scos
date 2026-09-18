---
github_project: "https://github.com/users/bonanaaaaaa/projects/1"
parent_issue: "https://github.com/bonanaaaaaa/scos/issues/6"
related_adrs:
  - docs/adr/0003-database-managed-timestamps.md
  - docs/adr/0001-advisory-verification.md
  - docs/adr/0004-deduplicate-accepted-orders.md
context_terms:
  - Destination
  - Warehouse Inventory
  - Order Request
  - Order Estimate
  - Order
  - Merchandise Subtotal
  - Volume Discount
  - Discounted Merchandise Total
  - Shipping Cost
  - Order Total
  - Insufficient Stock
  - Warehouse Allocation
  - Shipping Plan
issues: []
---

# SCOS Ordering PRD

## 1. Problem

People ordering SCOS Station P1 Pro devices need to know whether the requested quantity can be delivered, what it will cost after volume discounts, and whether shipping is within the permitted limit. An accepted order must use available warehouse stock without overselling or being duplicated when a caller repeats a submission after an uncertain response.

The assignment is backend-only; no frontend application is required. The deliverable is a backend that separates advisory Order Estimates from committed Orders, selects the lowest-cost Shipping Plan, and exposes understandable documentation and repeatable verification for an evaluator.

Sources are the supplied `bangkok-software-engineer-interview-challenge-sc-1-.pdf` and the design discussion recorded in [design decisions](../design-decisions.md). The PDF is a requirements reference, not authorization to email, publish, or deploy. Domain language follows [CONTEXT.md](../../CONTEXT.md). Implementation constraints remain in the linked design decisions rather than being duplicated here.

### Users

- **Ordering representative or integrating client:** submits an Order Request on behalf of a buyer, inspects an Order Estimate, and deliberately submits or repeats an order submission. This is a working persona, not a requirement for accounts or authentication.
- **Challenge evaluator or developer:** starts the backend, reads its served API documentation, exercises the flows, and verifies the required behavior.

## 2. Goals

- Help callers determine whether a requested quantity is fulfillable and understand its discounted merchandise, shipping, and total cost.
- Accept complete Orders against current inventory without overselling or leaving partial effects.
- Let callers repeat a submission after an uncertain response without creating duplicate Orders.
- Make the backend understandable and reproducible through served API documentation, documented setup, and verifiable acceptance criteria.

## 3. Non-goals

- Any frontend application, including customer-facing screens and admin dashboards. Served interactive API documentation remains part of the backend deliverable.
- Shopping carts, payment collection, tax calculation, currency conversion, or multiple products.
- Stock reservations or a guaranteed quote between verification and submission.
- Partial fulfillment, backorders, order cancellation, order listing, or inventory administration.
- Physical dispatch tracking, road-routing distance, carrier selection, or delivery-time guarantees.
- Storing or replaying business rejections. Only accepted Orders are deduplicated ([ADR 0004](../adr/0004-deduplicate-accepted-orders.md)).
- Creating GitHub issues, sending the submission, merging PRs, or provisioning cloud resources as part of authoring this PRD.

## 4. Requirements

The local core is **must-have (P1)**. The hosted demonstration is **optional (P2)** and remains a separate phase dependent on hosting, budget, and provisioning authorization.

### Must-have requirements (P1)

#### Shared commercial rules

These rules apply to estimation and submission:

- The single product is SCOS Station P1 Pro, priced at $150 per unit and weighing 365 grams per unit.
- Volume Discount is 0% below 25 units, 5% from 25, 10% from 50, 15% from 100, and 20% from 250. Apply only the highest qualifying tier to the entire Merchandise Subtotal, regardless of warehouse splits.
- Shipping costs $0.01 per kilogram per kilometre. Use great-circle distance to the Destination, and select the least-cost complete allocation subject to available stock. Equal-distance allocations are deterministic.
- Round the combined Shipping Cost once to cents, half-up. Compare that rounded charge to 15% of the Discounted Merchandise Total; equality is valid.
- Order Total includes Discounted Merchandise Total plus Shipping Cost. Returned and retained monetary amounts agree and are represented to clients as decimal strings.
- Fulfillment is all-or-nothing. No partial Order is offered when the full quantity is unavailable.

#### Estimate

- **Given** a positive integer quantity and valid Destination with sufficient stock, **when** verification runs, **then** it returns Merchandise Subtotal, Volume Discount, Discounted Merchandise Total, Shipping Cost, Order Total, and validity using the shared rules.
- **Given** a request requiring multiple warehouses, **when** an estimate is calculated, **then** its Shipping Plan fulfills the entire quantity at minimum shipping cost and never allocates more than a warehouse holds.
- **Given** shipping exceeds the permitted limit, **when** verification runs, **then** it returns an invalid estimate with an explicit shipping-limit reason and its calculated amounts.
- **Given** total stock is insufficient, **when** verification runs, **then** it returns an invalid estimate with an insufficient-stock reason, merchandise and discount amounts, and unavailable shipping/order totals represented as null.
- **Given** any verification request, **when** it completes, **then** it creates no Order, consumes or reserves no inventory, and guarantees no later submission outcome.

#### Submit

- **Given** a valid request against current inventory, **when** submitted successfully, **then** one Order receives a unique order number and its complete warehouse allocations are deducted immediately.
- **Given** an accepted Order, **when** its record is inspected, **then** it preserves quantity, Destination, applied pricing and discount, Shipping Cost, Order Total, and Warehouse Allocations as accepted at submission.
- **Given** inventory changed after verification, **when** the request is submitted, **then** the result is recalculated; it may cost more or become invalid rather than honoring stale availability.
- **Given** two submissions compete for remaining inventory, **when** processed concurrently, **then** only fulfillable Orders succeed and no warehouse stock becomes negative.
- **Given** a failure before acceptance is committed, **when** processing terminates, **then** no partial Order or partial inventory deduction remains.
- **Given** a business rejection, **when** submission completes, **then** no Order is created, inventory is unchanged, and the rejection is returned without being stored.

#### Repeat safely

- **Given** a submission identifier and the same request inputs, **when** the caller repeats the submission after acceptance, **then** it receives the original Order without another Order or inventory deduction.
- **Given** an identifier already belongs to an Order with different inputs, **when** it is reused, **then** a conflict is returned and the Order remains unchanged.
- **Given** simultaneous requests with the same identifier, **when** both finish, **then** at most one Order exists.
- **Given** a business rejection, malformed input, or a failure that committed nothing, **when** the same identifier is submitted again, **then** the identifier has not been consumed and the request is evaluated against current circumstances. Rejections are not stored ([ADR 0004](../adr/0004-deduplicate-accepted-orders.md)).
- **Given** an accepted Order, **when** the application restarts, **then** its identifier still returns that Order. No automatic expiry is required for this challenge.

#### Understand invalid requests

- Request validation uses Zod through the Standard Schema-compatible Hono middleware (`@hono/standard-validator`) at the HTTP boundary, with the constraints and error behavior below.
- **Given** zero, negative, fractional, missing, or otherwise invalid quantity, or missing/non-finite/out-of-range coordinates, **when** a request is received, **then** it is rejected as invalid input without inventory or Order changes.
- **Given** coordinates at valid geographic boundaries, **when** verification or submission occurs, **then** the boundaries are accepted: latitude -90 through 90 and longitude -180 through 180, inclusive.
- **Given** a well-formed but unfulfillable request, **when** verified, **then** the availability check succeeds and reports invalidity; **when** submitted, **then** it reports a business rejection. A business rejection is distinguishable from malformed input, identifier conflict, and temporary service failure.
- **Given** a temporary processing failure, **when** the caller receives the error, **then** the response does not imply acceptance; repeating the same submission identifier returns the Order if one was committed and otherwise evaluates the request again.

#### Discover the interface

- **Given** the application is running, **when** an evaluator requests its API specification, **then** the application serves a machine-readable OpenAPI document describing verification, submission, and health behavior.
- **Given** the application is running, **when** an evaluator opens its documentation, **then** interactive API documentation is served by the application itself.
- **Given** the documentation, **when** an evaluator follows its examples, **then** request constraints, decimal-string amounts, nullable totals, successful outcomes, rejections, conflicts, and repeat-submission semantics match actual behavior.
- **Given** an interface change, **when** verification runs, **then** specification validity and representative response conformance are checked so published documentation cannot silently drift.

#### Observe runtime behavior

- **Given** API traffic, **when** requests complete, **then** Pino structured JSON logs to stdout with correlation-only `@opentelemetry/instrumentation-pino`, traces and metrics describe request timing, status and business outcomes using documented OpenTelemetry conventions and shared service metadata.
- **Given** active trace context, **when** related logs and spans are emitted, **then** they correlate without leaking context between requests. Metrics use bounded dimensions; telemetry excludes secrets, raw request bodies and customer coordinates.
- **Given** unavailable telemetry export, **when** an order request executes, **then** its business result and transaction guarantees remain unchanged. Local telemetry verification is reproducible without a hosted account.

#### Reproduce and verify

- **Given** missing or invalid required environment configuration, **when** the server or Lambda runtime initializes, **then** Zod validation prevents it from accepting requests and reports safe variable names/reasons without revealing values. Required variables and safe defaults are documented; offline specification export remains independent of deployment secrets.
- **Given** a fresh checkout and documented prerequisites, **when** an evaluator follows setup instructions, **then** they can start the local application and database, initialize starting data, access documentation, and run the checks.
- **Given** a newly initialized development dataset, **when** inventory is inspected, **then** it contains the following warehouses with the supplied coordinates and unit counts:
  - Los Angeles: 33.9425, -118.408056; 355 units.
  - New York: 40.639722, -73.778889; 578 units.
  - São Paulo: -23.435556, -46.473056; 265 units.
  - Paris: 49.009722, 2.547778; 694 units.
  - Warsaw: 52.165833, 20.967222; 245 units.
  - Hong Kong: 22.308889, 113.914444; 419 units.
- **Given** the verification suite, **when** executed, **then** it exercises the commercial boundaries, allocation, rollback, concurrent-submission, and duplicate-submission scenarios defined above. Database-dependent guarantees are checked against a real database.
- **Given** unfinished or deferred work, **when** the evaluator reads the README, **then** limitations and next steps are explicit rather than represented as complete.

#### Edge cases

- **Empty state:** zero available inventory is Insufficient Stock for every otherwise-valid positive quantity. No partial shipment is presented as a complete estimate.
- **Loading state:** no product UI is required. Clients can have an in-flight submission with an unknown outcome; repeating its identifier follows the duplicate-submission requirements rather than creating a second Order.
- **Mid-flow failure:** order creation and inventory consumption succeed together or leave no partial effects. A response lost after commit is recovered by repeating the same submission identifier.
- **Permissions/authentication:** user accounts, roles, and entitlements are not defined by the challenge. This does not authorize public unauthenticated exposure; access controls remain a deployment decision.
- **Boundary inputs:** test 24/25, 49/50, 99/100, and 249/250 units; exact stock exhaustion; valid coordinate endpoints; and shipping below, equal to, and above the limit after rounding.
- **Repeated/concurrent actions:** a repeated identifier returns its accepted Order; conflicting reuse fails; separate submissions compete against current inventory without overselling.
- **Distance and rounding:** a Destination at a warehouse may have zero shipping cost; equal-distance stock choices are deterministic. Rounding individual allocations must not replace the agreed combined-charge rounding rule.
- **Historical values:** subsequent inventory or commercial changes do not rewrite accepted Order amounts.

### Optional: hosted demonstration (P2)

- **Given** an agreed deployment budget, hosting configuration, and authorization to provision, **when** the demonstration is deployed, **then** the core flows and served documentation are verified against that environment.
- **Given** the demonstration is no longer needed, **when** its teardown instructions are followed, **then** the created resources can be identified and removed with data-loss implications made clear.

## 5. Assumptions and open questions

### Accepted constraints and references

- All application-owned tables include created_at and updated_at, with database-managed updates, as specified in the [timestamp ADR](../adr/0003-database-managed-timestamps.md).

- Distances use Haversine with JavaScript number arithmetic and remain unrounded in kilometres before conversion to decimal.js. Preserve supplied coordinate precision without deliberate rounding; see the [distance precision policy](../design-decisions.md#distance-calculation-and-precision).

- decimal.js is the selected application monetary library. Persist final amounts as NUMERIC(12, 2), return decimal strings, and round combined shipping once using half-up rounding.

- Oxlint is the selected linter and Oxfmt is the selected formatter, as recorded in the [design decisions](../design-decisions.md).

- Core implementation was budgeted at approximately four hours, with review and deployment effort separate. The target discussed was Monday, September 21, 2026, Bangkok time; no more precise cutoff was given.
- [Design decisions](../design-decisions.md) contain the agreed language/runtime, monorepo, architecture, persistence, enum-table, and served API contract constraints. These remain binding even though the PRD focuses on product behavior.
- The relational schema follows third normal form (3NF), with each accepted order's applied price, discount, and shipping cost retained as historical facts and its totals derived exactly from them; see the [design decisions](../design-decisions.md#agreed-architecture).
- Generated database entity IDs use UUIDv7 for time-oriented sorting, as specified in the design decisions. Any persisted categorical values use text-key lookup tables; the submission identifier is a separate text key on the Order.
- [Advisory verification ADR](../adr/0001-advisory-verification.md) defines the distinction between an estimate and acceptance.
- [Order deduplication ADR](../adr/0004-deduplicate-accepted-orders.md) supersedes the [submission replay ADR](../adr/0002-replay-submission-outcomes.md): accepted Orders are deduplicated by submission identifier, and rejections are not stored.
- Dollar amounts are treated as USD for this single-currency challenge; international tax and customs charges are outside the supplied calculation rules.

### Feasibility and delivery dependencies

Repository inspection at PRD creation found design documents and local engineering workflow configuration, but no application implementation, package manifests, database schema, or test suite. All P1 capabilities are new work; none is claimed to exist yet.

The implementation must establish its workspace, runtime, local database, and verification harness before end-to-end acceptance can be demonstrated. Hosted verification depends on infrastructure that the user does not currently have. GitHub issue links are intentionally empty until issues are created separately.

### Open choices, not new product requirements

- The intermediate decimal.js significant-digit precision and exact Earth-radius constant must be fixed and verified during implementation; the distance representation and final rounding policy are settled.
- PostgreSQL hosting, connection configuration, deployment access controls, and the monthly demo budget are unresolved. They block hosted provisioning, not the local core.
- Monetary storage precision is settled in the linked design decisions. Operational input limits and handling amounts beyond the storage range remain implementation design details; no unagreed maximum order quantity or latency target is introduced here.

## 6. Success metrics

- Every P1 acceptance scenario has an executable check or documented reproducible verification, with no unresolved failing required check at handoff.
- Concurrency tests produce zero negative-stock results and zero duplicate Orders for the same submission identifier.
- Failure-injection tests leave zero partial inventory deductions or partial Orders after rollback.
- Pricing tests select the correct discount on both sides of every tier boundary and accept shipping equal to, but not above, the agreed limit.
- The running application serves both forms of API documentation; the specification validates and representative responses conform.
- An evaluator can reproduce local setup and testing using the README and the provided initial dataset.

No numerical latency, throughput, uptime, or cloud-cost target has been agreed. Do not substitute invented targets for acceptance criteria.
