---
github_project: "https://github.com/users/bonanaaaaaa/projects/1"
parent_issue: ""
related_adrs:
  - docs/adr/0001-advisory-verification.md
  - docs/adr/0002-replay-submission-outcomes.md
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

People ordering SCOS Station P1 Pro devices need to know whether the requested quantity can be delivered, what it will cost after volume discounts, and whether shipping is within the permitted limit. An accepted order must use available warehouse stock without overselling or being duplicated when a caller retries after an uncertain response.

The deliverable is a backend that separates advisory Order Estimates from committed Orders, selects the lowest-cost Shipping Plan, and exposes understandable documentation and repeatable verification for an evaluator.

Sources are the supplied `bangkok-software-engineer-interview-challenge-sc-1-.pdf` and the design discussion recorded in [design decisions](../design-decisions.md). The PDF is a requirements reference, not authorization to email, publish, or deploy. Domain language follows [CONTEXT.md](../../CONTEXT.md). Implementation constraints remain in the linked design decisions rather than being duplicated here.

## 2. Users

- **Ordering representative or integrating client:** submits an Order Request on behalf of a buyer, inspects an Order Estimate, and deliberately submits or retries an order attempt. This is a working persona, not a requirement for accounts or authentication.
- **Challenge evaluator or developer:** starts the backend, reads its served API documentation, exercises the flows, and verifies the required behavior.

## 3. User stories

- **S1 [P1] — Estimate:** As an ordering representative, I want to verify quantity and Destination so that I can see availability, the applicable discount, shipping, and the Order Total before committing.
- **S2 [P1] — Submit:** As an ordering representative, I want a valid request accepted against current inventory so that I receive an order number and a reliable record of the accepted amounts.
- **S3 [P1] — Retry safely:** As an integrating client, I want to retry an uncertain submission without creating another Order or consuming inventory twice.
- **S4 [P1] — Understand invalid requests:** As an integrating client, I want input errors and business rejections distinguished so that I can correct a request or begin a new attempt appropriately.
- **S5 [P1] — Discover the interface:** As an evaluator, I want the running application to serve machine-readable and interactive API documentation so that I can exercise its supported behavior.
- **S6 [P1] — Reproduce and verify:** As an evaluator, I want documented local setup, representative starting inventory, and meaningful automated checks so that I can assess the submission without bespoke environment knowledge.
- **S7 [P2] — Hosted demonstration:** As an evaluator, I want a disposable hosted demonstration so that I can exercise the backend remotely. Provisioning is a separate phase with unresolved hosting and budget prerequisites; it does not gate the core local submission.

## 4. Acceptance criteria

### Shared commercial rules

These rules apply to S1 and S2:

- The single product is SCOS Station P1 Pro, priced at $150 per unit and weighing 365 grams per unit.
- Volume Discount is 0% below 25 units, 5% from 25, 10% from 50, 15% from 100, and 20% from 250. Apply only the highest qualifying tier to the entire Merchandise Subtotal, regardless of warehouse splits.
- Shipping costs $0.01 per kilogram per kilometre. Use great-circle distance to the Destination, and select the least-cost complete allocation subject to available stock. Equal-distance allocations are deterministic.
- Round the combined Shipping Cost once to cents, half-up. Compare that rounded charge to 15% of the Discounted Merchandise Total; equality is valid.
- Order Total includes Discounted Merchandise Total plus Shipping Cost. Returned and retained monetary amounts agree and are represented to clients as decimal strings.
- Fulfillment is all-or-nothing. No partial Order is offered when the full quantity is unavailable.

### S1 — Estimate

- **Given** a positive integer quantity and valid Destination with sufficient stock, **when** verification runs, **then** it returns Merchandise Subtotal, Volume Discount, Discounted Merchandise Total, Shipping Cost, Order Total, and validity using the shared rules.
- **Given** a request requiring multiple warehouses, **when** an estimate is calculated, **then** its Shipping Plan fulfills the entire quantity at minimum shipping cost and never allocates more than a warehouse holds.
- **Given** shipping exceeds the permitted limit, **when** verification runs, **then** it returns an invalid estimate with an explicit shipping-limit reason and its calculated amounts.
- **Given** total stock is insufficient, **when** verification runs, **then** it returns an invalid estimate with an insufficient-stock reason, merchandise and discount amounts, and unavailable shipping/order totals represented as null.
- **Given** any verification request, **when** it completes, **then** it creates no Order, consumes or reserves no inventory, and guarantees no later submission outcome.

### S2 — Submit

- **Given** a valid request against current inventory, **when** submitted successfully, **then** one Order receives a unique order number and its complete warehouse allocations are deducted immediately.
- **Given** an accepted Order, **when** its record is inspected, **then** it preserves quantity, Destination, applied pricing and discount, Shipping Cost, Order Total, and Warehouse Allocations as accepted at submission.
- **Given** inventory changed after verification, **when** the request is submitted, **then** the result is recalculated; it may cost more or become invalid rather than honoring stale availability.
- **Given** two submissions compete for remaining inventory, **when** processed concurrently, **then** only fulfillable Orders succeed and no warehouse stock becomes negative.
- **Given** a failure before acceptance is committed, **when** processing terminates, **then** no partial Order, partial inventory deduction, or completed submission outcome remains.
- **Given** a business rejection, **when** submission completes, **then** no Order is created and inventory is unchanged, while the rejection remains available for replay under S3.

### S3 — Retry safely

- **Given** a submission attempt identifier and the same request inputs, **when** the caller retries after successful acceptance, **then** it receives the original accepted outcome without another Order or inventory deduction.
- **Given** a business rejection saved for an attempt, **when** the same attempt is retried, **then** the original rejection is returned even if circumstances have changed.
- **Given** a deliberate new attempt after rejection, **when** the caller uses a new identifier, **then** the request is evaluated against current circumstances.
- **Given** an identifier already belongs to different inputs, **when** it is reused, **then** a conflict is returned and its original outcome remains unchanged.
- **Given** simultaneous requests with the same identifier, **when** both finish, **then** at most one Order exists and matching requests observe the same business outcome.
- **Given** malformed input or a transient failure that did not commit an outcome, **when** the request is corrected or retried, **then** the identifier has not been consumed by that failed attempt.
- **Given** a completed business outcome, **when** the application restarts, **then** replay remains available. No automatic expiry is required for this challenge.

### S4 — Understand invalid requests

- **Given** zero, negative, fractional, missing, or otherwise invalid quantity, or missing/non-finite/out-of-range coordinates, **when** a request is received, **then** it is rejected as invalid input without inventory or Order changes.
- **Given** coordinates at valid geographic boundaries, **when** verification or submission occurs, **then** the boundaries are accepted: latitude -90 through 90 and longitude -180 through 180, inclusive.
- **Given** a well-formed but unfulfillable request, **when** verified, **then** the availability check succeeds and reports invalidity; **when** submitted, **then** it reports a business rejection. A business rejection is distinguishable from malformed input, identifier conflict, and temporary service failure.
- **Given** a temporary processing failure, **when** the caller receives the error, **then** the response does not imply acceptance; repeating the same attempt can recover any previously committed result.

### S5 — Discover the interface

- **Given** the application is running, **when** an evaluator requests its API specification, **then** the application serves a machine-readable OpenAPI document describing verification, submission, and health behavior.
- **Given** the application is running, **when** an evaluator opens its documentation, **then** interactive API documentation is served by the application itself.
- **Given** the documentation, **when** an evaluator follows its examples, **then** request constraints, decimal-string amounts, nullable totals, successful outcomes, rejections, conflicts, and retry semantics match actual behavior.
- **Given** an interface change, **when** verification runs, **then** specification validity and representative response conformance are checked so published documentation cannot silently drift.

### S6 — Reproduce and verify

- **Given** a fresh checkout and documented prerequisites, **when** an evaluator follows setup instructions, **then** they can start the local application and database, initialize starting data, access documentation, and run the checks.
- **Given** a newly initialized development dataset, **when** inventory is inspected, **then** it contains the following warehouses with the supplied coordinates and unit counts:
  - Los Angeles: 33.9425, -118.408056; 355 units.
  - New York: 40.639722, -73.778889; 578 units.
  - São Paulo: -23.435556, -46.473056; 265 units.
  - Paris: 49.009722, 2.547778; 694 units.
  - Warsaw: 52.165833, 20.967222; 245 units.
  - Hong Kong: 22.308889, 113.914444; 419 units.
- **Given** the verification suite, **when** executed, **then** it exercises the commercial boundaries, allocation, rollback, concurrent submissions, and replay scenarios in S1-S4. Database-dependent guarantees are checked against a real database.
- **Given** unfinished or deferred work, **when** the evaluator reads the README, **then** limitations and next steps are explicit rather than represented as complete.

### S7 — Hosted demonstration

- **Given** an agreed deployment budget, hosting configuration, and authorization to provision, **when** the demonstration is deployed, **then** the core flows and served documentation are verified against that environment.
- **Given** the demonstration is no longer needed, **when** its teardown instructions are followed, **then** the created resources can be identified and removed with data-loss implications made clear.

## 5. Edge cases

- **Empty state:** zero available inventory is Insufficient Stock for every otherwise-valid positive quantity. No partial shipment is presented as a complete estimate.
- **Loading state:** no product UI is required. Clients can have an in-flight submission with an unknown outcome; repeating its identifier follows S3 rather than creating a deliberate new attempt.
- **Mid-flow failure:** order creation, inventory consumption, and accepted-outcome persistence succeed together or leave no partial effects. Committed business rejections remain replayable. A lost response after commit is recovered by retrying the same attempt.
- **Permissions/authentication:** user accounts, roles, and entitlements are not defined by the challenge. This does not authorize public unauthenticated exposure; access controls remain a deployment decision.
- **Boundary inputs:** test 24/25, 49/50, 99/100, and 249/250 units; exact stock exhaustion; valid coordinate endpoints; and shipping below, equal to, and above the limit after rounding.
- **Repeated/concurrent actions:** identical attempts replay; conflicting reuse fails; separate attempts compete against current inventory without overselling.
- **Distance and rounding:** a Destination at a warehouse may have zero shipping cost; equal-distance stock choices are deterministic. Rounding individual allocations must not replace the agreed combined-charge rounding rule.
- **Historical values:** subsequent inventory or commercial changes do not rewrite accepted Order amounts or saved submission outcomes.

## 6. Measurable success criteria

- Every P1 acceptance scenario has an executable check or documented reproducible verification, with no unresolved failing required check at handoff.
- Concurrency tests produce zero negative-stock results and zero duplicate Orders for the same submission attempt.
- Failure-injection tests leave zero partial inventory deductions or partial Orders after rollback.
- Pricing tests select the correct discount on both sides of every tier boundary and accept shipping equal to, but not above, the agreed limit.
- The running application serves both forms of API documentation; the specification validates and representative responses conform.
- An evaluator can reproduce local setup and testing using the README and the provided initial dataset.

No numerical latency, throughput, uptime, or cloud-cost target has been agreed. Do not substitute invented targets for acceptance criteria.

## 7. Non-goals

- A customer-facing frontend, shopping cart, payment collection, tax calculation, currency conversion, or multiple products.
- Stock reservations or a guaranteed quote between verification and submission.
- Partial fulfillment, backorders, order cancellation, order listing, or inventory administration.
- Physical dispatch tracking, road-routing distance, carrier selection, or delivery-time guarantees.
- A full user-account, authorization, or multi-tenant product.
- Automatic expiry of saved submission outcomes in this challenge.
- Creating GitHub issues, sending the submission, merging PRs, or provisioning cloud resources as part of authoring this PRD.

## 8. Assumptions, dependencies, and open questions

### Accepted constraints and references

- Core implementation was budgeted at approximately four hours, with review and deployment effort separate. The target discussed was Monday, September 21, 2026, Bangkok time; no more precise cutoff was given.
- [Design decisions](../design-decisions.md) contain the agreed language/runtime, monorepo, architecture, persistence, enum-table, and served API contract constraints. These remain binding even though the PRD focuses on product behavior.
- [Advisory verification ADR](../adr/0001-advisory-verification.md) defines the distinction between an estimate and acceptance.
- [Submission replay ADR](../adr/0002-replay-submission-outcomes.md) defines stable outcomes per attempt and new identifiers for new attempts.
- Dollar amounts are treated as USD for this single-currency challenge; international tax and customs charges are outside the supplied calculation rules.

### Feasibility and delivery dependencies

Repository inspection at PRD creation found design documents and local engineering workflow configuration, but no application implementation, package manifests, database schema, or test suite. All P1 capabilities are new work; none is claimed to exist yet.

The implementation must establish its workspace, runtime, local database, and verification harness before end-to-end acceptance can be demonstrated. Hosted verification depends on infrastructure that the user does not currently have. GitHub issue links are intentionally empty until issues are created separately.

### Open choices, not new product requirements

- Linter/formatter selection remains open: Oxlint was recommended, while Biome was also considered.
- The monetary implementation remains open after discussion of decimal libraries and native bigint. Any choice must preserve the accepted commercial results and rounding rules; adopting integer distance units requires a documented precision decision.
- PostgreSQL hosting, connection configuration, deployment access controls, and the monthly demo budget are unresolved. They block hosted provisioning, not the local core.
- Exact monetary storage precision and operational limits must be reconciled in the implementation design; no unagreed maximum order quantity or latency target is introduced here.
