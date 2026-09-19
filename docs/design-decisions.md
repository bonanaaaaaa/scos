# Design interview decisions

## Agreed scope and constraints

- Produce a submission-ready design before implementation.
- The assignment is backend-only. Frontend applications, customer-facing screens, and admin dashboards are out of scope. Serving OpenAPI and interactive API documentation from the backend remains required.
- Deadline: next Monday, interpreted as September 21, 2026, Bangkok time.
- Budget: approximately four hours for core implementation, with separate review time.
- Deployment provisioning has a separate budget from the four-hour core implementation.
- Stack: TypeScript 7 (required), Hono, Prisma, PostgreSQL. Deploy first on Cloudflare Workers with PlanetScale Postgres through Cloudflare Hyperdrive; the AWS Lambda deployment is deferred, not dropped. See [ADR 0005](adr/0005-cloudflare-first-deployment.md).
- Deferred AWS target: Lambda with RDS Proxy as the database connection approach (see Agreed architecture). Because RDS Proxy fronts Amazon RDS for PostgreSQL or Aurora PostgreSQL, hosting there is narrowed to those two; the engine and instance choice remains open.
- Use a pnpm workspace and Turborepo monorepo. Oxlint is the selected linter and Oxfmt is the selected formatter. Type-aware lint rule configuration remains an implementation choice to finalize.
- Use hexagonal architecture and domain-driven design (DDD), with one Ordering bounded context covering pricing, shipping allocation, orders, and available inventory.
- Do not use the experimental, non-standard Idempotency-Key HTTP header. Use a required client-generated submissionId in the JSON request body to prevent duplicate Orders. See [ADR 0004](adr/0004-deduplicate-accepted-orders.md).
- Target a disposable demo deployment with documented teardown. The user has no existing cloud infrastructure or PostgreSQL database to reuse; the monthly budget is not yet specified.

## Agreed behavior

- Verification returns an advisory estimate without reserving inventory.
- Submission recalculates against current inventory. It may have a different shipping cost or become invalid after verification.
- Successful submission accepts the order and consumes its inventory atomically.
- Order total includes shipping; the shipping limit is measured against discounted merchandise only.
- Apply the highest eligible volume-discount tier to the entire order, independent of warehouse splits.
- Reject insufficient stock explicitly, without changing inventory or offering partial fulfillment.
- For insufficient stock, verification returns HTTP 200 with valid: false, reason INSUFFICIENT_STOCK, calculated merchandise and discount amounts, and null shippingCost and orderTotal. Submission returns HTTP 422 with INSUFFICIENT_STOCK and creates no order.
- Use decimal.js for application monetary calculations behind domain value objects and pricing functions, independently of Prisma types. Construct monetary constants and persisted amounts from decimal strings. Use an isolated Decimal configuration with explicit intermediate precision and ROUND_HALF_UP; choose and validate sufficient significant-digit precision for supported inputs rather than setting calculation precision to the two-decimal storage scale. Sum unrounded shipping contributions before the final cent rounding. Geographic distance follows the precision policy below; decimal arithmetic does not remove approximation in geographic distances.
- Persist monetary amounts using PostgreSQL NUMERIC(12, 2): 12 total digits, including two fractional digits. Use exact monetary arithmetic in the application, preserving intermediate precision until the agreed rounding point. Round combined shipping once to two decimal places using half-up rounding, then compare that charge against 15% of the discounted merchandise total; equality passes. Persisted facts must reproduce exactly the monetary amounts returned to the customer; derived totals are computed from the stored values (see Agreed architecture).
- Calculate great-circle distances and allocate nearest warehouses first until fulfilled; use stable warehouse IDs to break equal-distance ties.
- Prevent overselling by locking all six warehouse inventory rows in stable ID order inside a database transaction before reading stock and calculating allocation. Validate the request, decrement stock, and save the order within that transaction; retry temporary transaction conflicts a bounded number of times.
- Store the submissionId as a unique key on the accepted Order. Repeating the same key and inputs returns the original Order without consuming additional stock; reusing the key with different inputs returns a conflict.
- Only accepted Orders are persisted. Business rejections are returned and not stored, so a rejected, malformed, or failed request consumes no key and is reevaluated when repeated.
- Require positive integer quantities and finite destination coordinates within geographic bounds. Malformed inputs return HTTP 400; verification returns HTTP 200 with validity and reasons; submission returns HTTP 201 when accepted, HTTP 422 for business rejection, and HTTP 409 for reuse of a submissionId with different inputs.
- Return monetary amounts as decimal strings, such as "150.00".
- Preserve each accepted order's quantity, destination, applied pricing and discount, and warehouse allocations in addition to its order number and totals.
- Provide POST /api/v1/orders/verify, POST /api/v1/orders (with submissionId in its JSON body), and GET /health, with OpenAPI documentation and examples. Listing, cancellation, and inventory administration are outside submission scope.
- The order endpoints are versioned under the `/api/v1` prefix, defined once as `API_PREFIX` in the API adapter's route contract. `GET /health` stays at the root as a liveness probe outside the API surface. The unprefixed paths are not aliases or redirects; they return the standard 404 envelope.

## Agreed architecture

- Every application-owned table includes non-null created_at and updated_at timestamps maintained by PostgreSQL triggers, including lookup tables. See [database-managed timestamps](adr/0003-database-managed-timestamps.md) for semantics, example SQL, and verification.

- The Order aggregate owns accepted order details and allocations. Quantity, destination, and money are value objects; discount and shipping-plan calculations are domain functions.
- Use third normal form (3NF) as the relational database design baseline. Separate entity facts and relationships, enforce keys and foreign keys, and evaluate functional dependencies beyond the UUID primary key. Accepted order prices, discounts, shipping charges, and totals are immutable historical facts; preserve them rather than deriving them from current commercial rules. Store the independent facts (quantity, unit price, discount rate and amount, shipping cost) and derive subtotals and the Order Total from those stored values with exact decimal arithmetic, so the amounts returned always equal what was charged. Any deliberate denormalization requires a documented reason.
- Inventory is persisted separately. The SubmitOrder application use case coordinates inventory changes and order creation atomically.
- Hono is an inbound adapter calling VerifyOrder and SubmitOrder application use cases. A runtime entry point starts the application: the Node server locally, a Cloudflare Worker for the first hosted deployment, and Lambda handlers later.
- Each endpoint is a separately constructible Hono app with its own composition root (`GET /health`, `POST /api/v1/orders/verify`, `POST /api/v1/orders`), building only the adapters it needs, so each can be deployed as its own Lambda function. A combined app mounts all three for local serving, the Cloudflare Worker, and the API documentation routes, with identical responses.
- The Cloudflare Worker reaches PlanetScale Postgres through Hyperdrive, which pools connections in transaction mode. Create the database client inside the request handler, per request: Workers does not allow I/O objects to be reused across requests. Set lock and statement timeouts inside each transaction, because Hyperdrive resets a connection when it returns to the pool; rely on no session state or session-level advisory locks. Disable Hyperdrive query caching, because it does not invalidate cached reads on write and inventory reads must never be stale. Migrations connect directly to PlanetScale with a separate migration role (#28, #15).
- PlanetScale Postgres and Hyperdrive (#28): region `ap-southeast` (AWS Singapore), a PS-5 single-node cluster, `main` as the production branch with no development branch, one Hyperdrive configuration with caching disabled, and `origin_connection_limit` starting at 5, revisited in #33. The estimated cost is $5 a month, excluding Cloudflare charges. Details, the connection budget rule and #15's inputs: [Cloudflare deployment design](cloudflare-deployment-design.md).
- Deferred AWS target: Lambda functions reach PostgreSQL through RDS Proxy, which pools connections across all per-endpoint functions and bounds the connections reaching the database. Nothing sets the in-process pool size yet (pg defaults to 10); the recommendation for deployment (#14) is to apply and verify a pool of at most one connection per execution environment, which serves one request at a time. Deployment must also check whether session settings or prepared statements pin connections, and verify IAM or Secrets Manager authentication and proxy timeouts.
- Application use cases depend on the domain model and application-owned persistence interfaces. The Prisma outbound adapter implements persistence and transaction locking.
- Prisma types and HTTP objects stay outside the domain and application use cases.
- A transaction interface encompasses the duplicate-key lookup, stock reads, order and allocation persistence, and inventory updates together.
- Persist accepted Orders as snapshots, not HTTP status codes or HTTP response envelopes. The Hono adapter maps accepted, rejected, and conflicting outcomes to HTTP responses, including when an existing Order is returned.
- Use UUIDv7 for generated database entity IDs, stored in PostgreSQL UUID columns; referencing foreign keys use the same type. This includes warehouse and order IDs and allocation IDs. Keep seeded warehouse UUIDv7 values stable across seed runs so lock ordering and equal-distance allocation remain deterministic.
- UUIDv7 supports time-oriented ID sorting, not a guarantee of transaction commit order or strict chronology across concurrent generators. Use explicit ORDER BY for ordered results. See [RFC 9562, section 5.7](https://www.rfc-editor.org/rfc/rfc9562.html#name-uuid-version-7). The generation mechanism remains an implementation choice.
- Hasura-style enum lookup tables retain their agreed text primary keys. The client-generated submissionId is a separate text key on the Order, not a database ID; this decision does not change its API contract or the order-number format.
- Use Hasura-style enum lookup tables with text primary keys and foreign keys for persisted categorical values; do not use PostgreSQL native enums or Prisma enum declarations that create them. The current schema persists no categorical values, because submission outcomes and rejection codes are no longer stored; apply this pattern if any are introduced. This adopts the database pattern without adding Hasura to the stack.
- Maintain lookup values through versioned migrations. Prisma represents these as String fields and relations; domain types remain string literal unions with validation at the adapter seam. Referenced values cannot be removed until references are migrated; avoid cascading deletion of historical records.
- Enum-table reference: https://hasura.io/docs/2.0/schema/postgres/enums/ . Use text primary keys, optional descriptions, at least one value, and GraphQL-compatible value names. All application tables also require created_at and updated_at; this intentionally supersedes strict Hasura enum-table shape compatibility as recorded in ADR 0003. Insert initial values in migrations rather than relying on development seeds. Hasura metadata configuration is not needed in our Hono/Prisma stack.

## Distance calculation and precision

- Use the Haversine formula for great-circle distance on a spherical Earth, with JavaScript number arithmetic for trigonometry. Use one documented Earth-radius constant in kilometres consistently for verification and submission; its exact value must be fixed alongside reference-distance tests during implementation.
- Preserve the supplied warehouse coordinates and accepted client coordinates without deliberate decimal-place rounding. JavaScript number representation remains finite precision; do not claim arbitrary-precision coordinates or measurement accuracy from the number of supplied digits.
- Keep computed distances in kilometres without rounding to whole metres, whole kilometres, or a fixed number of decimal places. Use those distances for allocation and convert each result via its decimal string representation into decimal.js for shipping arithmetic.
- Multiply using decimal constants for unit weight and shipping rate, sum all warehouse shipping contributions, and round the combined charge once to cents using ROUND_HALF_UP. Do not round individual contributions or distance values first.
- Clamp the Haversine intermediate to the mathematical range [0, 1] before calculating the central angle to avoid floating-point drift producing invalid results at geographic extremes.
- Coordinate precision is distinct from measurement accuracy and spherical-model accuracy. The [OpenStreetMap coordinate precision reference](https://wiki.openstreetmap.org/wiki/Precision_of_coordinates) informs this distinction; its local distance approximation is not the algorithm for globally distributed warehouses.

## Agreed validation strategy

- Validate environment configuration with Zod once at runtime bootstrap, before constructing runtime clients, starting the HTTP listener, or accepting Worker requests or Lambda invocations. Missing or invalid required variables fail startup (nonzero exit for the server; a sanitized failure before any request is served for the Worker; failed initialization for Lambda). Report variable names and safe validation reasons only, never values, credentials or connection strings.
- Export typed, validated configuration from the composition boundary and inject it into adapters instead of scattered `process.env` reads. Document required, optional and conditional variables in `.env.example`; defaults apply only where explicitly safe. Required variables depend on the enabled runtime mode (for example, telemetry endpoints when export is enabled). Parse environment strings explicitly and reject malformed values.
- Keep pure app construction, unit tests and offline OpenAPI export independent of deployment environment validation; validation belongs to executable runtime entrypoints. A configured but unavailable database does not prevent the database-independent health handler from functioning; schema validation is not a database connectivity probe.
- Validate incoming HTTP requests with Zod schemas through hono-openapi's `validator`, which wraps Hono's Standard Schema middleware, `sValidator` from `@hono/standard-validator`. Keep HTTP schemas and HTTP error mapping in the inbound API adapter; their limits must match the core constants (`MAX_QUANTITY`, `LATITUDE_LIMIT`, `LONGITUDE_LIMIT`). The domain core also uses Zod schemas for its own input guards (quantity, destination, order request), returning `safeParse` results; domain invariant violations still throw `DomainError`. The core remains independent of Hono.
- Apply the agreed quantity, coordinate and submissionId constraints before invoking use cases. Map schema failures and malformed JSON to the documented HTTP 400 envelope, without consuming submission IDs or mutating inventory. Do not implicitly coerce strings into JSON numbers; document content-type and unknown-field behavior and verify them in API tests.
- Generate the OpenAPI specification with hono-openapi from the same request and response schemas (`describeRoute`, `resolver`, and the schemas given to `validator`). Standard Schema validation alone does not generate OpenAPI. Verify that refinements and numeric limits are accurately represented or explicitly documented, and that generated schemas match runtime behavior.
- Reference: [Hono Standard Schema request validation](https://hono.dev/docs/guides/validation#standard-schema-validator-middleware).
- Unit tests cover discount boundaries, allocation, rounding, and the shipping limit. Distance tests cover identical locations, geographic boundaries, international date-line crossings, nearly antipodal points, and reference distances under the chosen Earth-radius constant.
- Real PostgreSQL tests of rollback, simultaneous submissions, and duplicate submissionId handling run at the full-stack level with the API (#11), not as a separate core-plus-persistence integration test.
- Provide easy local start/test commands and documented API examples.

## OpenAPI deliverable

- Deliver a machine-readable OpenAPI specification for POST /api/v1/orders/verify, POST /api/v1/orders, and GET /health, generated from the API adapter's route and validation schemas.
- Serve the specification at GET /openapi.json and interactive API documentation at GET /docs. Generate the specification during the API build as an uncommitted artifact, apps/api/dist/openapi.json, deterministically and without starting the application or connecting to PostgreSQL; keep an on-demand export command. The specification is not committed, so there is no drift check.
- The route contracts and their Zod schemas are the single source of truth for the API contract: they validate requests at runtime and generate the specification. A committed copy of the specification would be a second, derived source that can go stale and needs a drift check to stay honest, so the specification is only ever generated, both when served and when built.
- Document request and response schemas, quantity and coordinate constraints, submissionId, decimal-string monetary amounts, nullable totals for insufficient stock, and business rejection codes.
- Include examples of valid verification, insufficient stock, excessive shipping, accepted submission, rejected submission, a repeated submissionId returning the original Order, and conflicting submissionId reuse. State that rejections are not stored.
- Document success responses and malformed-input, business-rejection, conflicting-ID, and transient-failure responses. HTTP status mapping belongs to the API adapter and specification, never persisted records.
- Validate the generated specification and check representative HTTP responses against its schemas. Check that the build artifact matches the served /openapi.json.

## Verification and submission sequence

Verification is advisory: another order can consume inventory before submission. The following flow shows a submission with a new submissionId. Repeating the submissionId of an accepted Order returns that Order without deducting stock again; reuse with different inputs returns a conflict.

```mermaid
sequenceDiagram
    actor User
    participant API as Hono API
    participant DB as PostgreSQL
    actor Other as Another user

    User->>API: Verify quantity and destination
    API->>DB: Read available inventory
    DB-->>API: Current stock
    API->>API: Calculate pricing and shipping
    API-->>User: Estimate and validity
    Note over API,DB: No Order created and no stock reserved or deducted

    Other->>API: Submit another order
    API->>DB: Accept order and deduct stock atomically
    API-->>Other: Order accepted

    User->>API: Submit with new submissionId
    rect rgb(235, 245, 255)
        Note over API,DB: One database transaction
        API->>DB: Lock warehouse rows in stable ID order
        DB-->>API: Current inventory
        API->>DB: Look up Order by submissionId (none found)
        API->>API: Recalculate pricing and shipping
        alt Fulfillable and shipping within limit
            API->>DB: Save Order with submissionId and allocations, deduct stock
        else Insufficient stock or shipping exceeds limit
            Note over API,DB: Save nothing; stock unchanged
        end
        API->>DB: Commit
    end
    API-->>User: Accepted Order or business rejection
```

## Observability

- Use `pino` with `@opentelemetry/instrumentation-pino` (`PinoInstrumentation`) for application logging. Register instrumentation before importing Pino or constructing loggers, and verify the built Node/Lambda module-loading path is instrumented.
- Keep automatic log correlation enabled with default `trace_id`, `span_id`, and `trace_flags` keys. When no valid active span exists, omit those fields. Set `disableLogSending: true` and `disableLogCorrelation: false`. Do not configure an application OTel Logs SDK/LoggerProvider or log exporter; the JavaScript Logs SDK is currently in Development. Traces and metrics use their stable SDKs.
- Pino emits structured JSON to stdout for platform/collector ingestion. Document the collection path and Pino-to-OTel field mapping; do not add `pino-opentelemetry-transport` or duplicate ingestion. Application OTLP export is for traces and metrics only.
- Pin compatible Pino/instrumentation/SDK versions. Verify severity mapping, child loggers, redaction on stdout/collected records, trace correlation and single-record output. The instrumentation does not supply HTTP semantic attributes automatically; request instrumentation must provide them.
- Reference: [Pino instrumentation README](https://github.com/open-telemetry/opentelemetry-js-contrib/tree/main/packages/instrumentation-pino#readme).
- Use OpenTelemetry-aligned structured JSON logs, tracing and metrics. Keep instrumentation and SDK/export configuration in adapters/composition, with no OTel dependency in the domain.
- Map logs explicitly to the OTel LogRecord data model, including timestamp, severity, body, attributes and resource/scope. Correlate active trace/span IDs; submission IDs remain separate business identifiers. Use consistent service name, version and environment across signals.
- Propagate valid W3C trace context through request, use-case and persistence instrumentation without leaking context across concurrent requests. Distinguish business outcomes from unexpected system errors.
- Record HTTP request duration in seconds under stable HTTP semantic conventions and a documented submission-request outcome counter (including replay outcomes). Use bounded metric dimensions and route templates, never per-request IDs or raw URLs.
- Exclude request bodies, credentials, tokens, database parameters and destination coordinates from telemetry. Sanitize errors. Use bounded asynchronous export, configurable sampling and documented OTLP/local test-sink configuration. Telemetry failures must not change order outcomes or extend database transactions.
- Developers own instrumentation unit/integration tests; QA validates telemetry via API scenarios. Hosted delivery must verify bounded flush behavior: through `ctx.waitUntil` on Workers, and with warm reuse on Lambda. Telemetry backend provisioning is a separate deployment choice.
- Cloudflare Workers (#17, for #28) keeps the same signals, attributes, redaction and ports with its own composition: the OpenTelemetry JS SDK in the Worker with per-request OTLP export over `fetch` under `ctx.waitUntil` (DELTA metrics), an `AsyncLocalStorage` context manager (`nodejs_compat`), the console JSON logger writing record objects to `console.log` (no Pino, no OTel Logs export), and Cloudflare's automatic tracing left off so spans are not duplicated. Prisma 7 runs on workerd through a second, `runtime = "workerd"` client build of `@scos/persistence`; each request creates its own Prisma client over a pg `Pool` of at most 2 connections on the Hyperdrive connection string and releases it when the request ends, as #28 and Cloudflare's connection-lifecycle guidance require. Rationale and limits: [docs/observability.md](observability.md#cloudflare-workers-runtime).
- Implementation, configuration, field mapping and sample output: [docs/observability.md](observability.md).
- References: [OTel logs](https://opentelemetry.io/docs/specs/otel/logs/data-model/), [HTTP spans](https://opentelemetry.io/docs/specs/semconv/http/http-spans/), [HTTP metrics](https://opentelemetry.io/docs/specs/semconv/http/http-metrics/).

## Unresolved

- Monthly demo budget; deployment starts from scratch.
- Deferred with the AWS target: PostgreSQL engine and instance choice, Amazon RDS for PostgreSQL or Aurora PostgreSQL (the two that RDS Proxy fronts). The connection approach there is decided: RDS Proxy.
- Deployment exposure and packaging, subject to Q26 infrastructure and budget constraints.
