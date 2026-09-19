# Deploy to Cloudflare Workers and PlanetScale Postgres first; AWS Lambda later

The original plan hosted the demonstration on AWS: one Lambda function per endpoint, reaching Amazon RDS or Aurora PostgreSQL through RDS Proxy. On 2026-09-19 an AWS account issue blocked that track before the submission deadline. The hosted demonstration now ships first on Cloudflare Workers, with the data in PlanetScale Postgres and the Worker reaching it through Cloudflare Hyperdrive. The AWS Lambda deployment is deferred, not dropped: its design stays in the documentation and resumes after the Cloudflare demonstration (#14, #16, draft PR #31).

Neither target touches the domain. Both are driving adapters over the same Hono composition, which is why the switch is a change of entry point and infrastructure only.

Decisions for the Cloudflare target:

- **One Worker serves all routes.** The per-endpoint composition roots stay, because the Lambda target still needs them, but Workers gains nothing from splitting: there is no per-function cold start or connection pool to isolate.
- **The database client is created per request, inside the handler.** Workers does not allow I/O objects to be reused across requests, so a client held in global scope fails. Hyperdrive keeps per-request connection setup cheap. This is the opposite of the Lambda guidance, where one pooled connection is reused across warm invocations.
- **Hyperdrive pools in transaction mode.** The submission transaction's row locks work unchanged. Lock and statement timeouts are set inside each transaction, because Hyperdrive resets a connection when it returns to the pool. Nothing may rely on session state or session-level advisory locks.
- **Hyperdrive query caching is disabled.** Hyperdrive does not invalidate cached reads when the application writes, so a cached inventory read could return stale stock.
- **Each resource has one owner.** A `pscale` CLI bootstrap script creates the PlanetScale database (billed through the Cloudflare account) and its runtime and migration roles. It runs from a manually triggered GitHub Actions workflow behind a deployment-environment approval, authenticated with a PlanetScale service token (the token ID as an environment variable, the token as an environment secret). Terraform manages the Cloudflare side (the Hyperdrive configuration and any DNS), with state in a private R2 bucket. Wrangler deploys the Worker.
- **Migrations connect directly to PlanetScale** with the migration role, not through Hyperdrive.

Consequences:

- Creating the database starts daily billing, so it stays a deliberate, authorized step: a manual workflow run that a person approves. Nothing triggered by a push or a merge creates or deletes the database.
- The pipeline holds a PlanetScale service token and scoped Cloudflare tokens as GitHub environment secrets, each limited to what its job needs. Unless GitHub OIDC federation turns out to be available, that is a downgrade from the AWS design's short-lived credentials, and it is accepted.
- The Terraform state holds the runtime role's password (Hyperdrive's origin credential), so the state bucket is treated as a secret.
- Telemetry needs a Workers composition, because the Node SDK and `PinoInstrumentation` do not run in a bundled Worker. That composition is a follow-up under #17 and is flushed through `ctx.waitUntil`.
- #15 now delivers the Cloudflare pipeline. When the AWS track resumes it needs a pipeline issue of its own (`infra/aws/`, GitHub OIDC, Lambda) between #14 and #16.
- Work is tracked in #28 (Worker runtime and Hyperdrive design), #15 (bootstrap, Terraform, and pipeline), and #33 (hosted demonstration).
