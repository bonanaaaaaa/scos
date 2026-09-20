# Cloudflare deployment design: PlanetScale Postgres through Hyperdrive

This is the design record for #28. It settles the PlanetScale Postgres
cluster, the Hyperdrive configuration and the connection budget that #15
encodes and #33 verifies. [ADR 0005](adr/0005-cloudflare-first-deployment.md)
records why the first hosted demonstration runs on Cloudflare Workers.

## Scope and status

- **Design, now provisioned.** This record was written as design only, and
  every value below was an input for #15 rather than a resource. The design
  has since been deployed: what actually exists, and what it costs, is in
  [hosted demonstration](hosted-demonstration.md). Where the two disagree,
  the hosted record is the live one.
- **Checked on 2026-09-19.** Platform limits and prices come from the
  [sources](#sources) as they read on that date. Re-check them before #15
  runs the bootstrap.
- **Ownership.** #28 owns the Worker runtime and this design. #15 owns the
  PlanetScale bootstrap, Terraform, credentials and the pipeline. #33 owns the
  hosted deployment and every measurement under load.
- **Implemented by #15** in [PlanetScale bootstrap](planetscale-bootstrap.md)
  and [deployment pipeline](deployment-pipeline.md).
- **Not decided here.** The monthly budget, the account and organization, and
  the provisioning authorization belong to the user (see
  [remaining approvals](#remaining-approvals-and-verification-for-33)).

## PlanetScale Postgres

### Region

**AWS Singapore, `ap-southeast`.** Users and evaluators are in Bangkok, and
Singapore is the closest region PlanetScale lists. The regions page lists no
Postgres exclusions for it.

### Cluster size

**Decision: PS-5, single node** (1/16 vCPU, 512 MiB, $5/month in
`ap-southeast`).

| Option      | vCPU / memory     | Price in `ap-southeast` | Egress included |
| ----------- | ----------------- | ----------------------- | --------------- |
| PS-5 single | 1/16 vCPU, 512MiB | $5/month                | 10 GB/month     |
| PS-5 HA     | 1/16 vCPU, 512MiB | $15/month               | 100 GB/month    |

Reasoning:

- **Load.** The demo holds six warehouse rows and a handful of Orders. Every
  submission locks all six warehouse rows, so submissions run one at a time
  whatever the cluster size. More CPU shortens each lock hold; it does not
  add parallelism.
- **Connections.** PlanetScale does not publish `max_connections` per size.
  The budget below needs only the Hyperdrive origin pool (minimum 5) plus
  reserved and migration/admin headroom, so a small value is likely enough.
  This is unverified until the cluster exists.
- **HA is not needed.** The demo is disposable, and an outage of a replica
  set is not an acceptance criterion. HA triples the price, to $15/month.
- **Prices vary by region.** Singapore can cost more than other regions for
  the same size. Latency to Bangkok outweighs that difference.

PS-5 stays unless the user decides otherwise. #33 reports back if either
holds:

1. After creation, the cluster's Parameters tab shows a `max_connections`
   that does not fit the [connection budget rule](#connection-budget) with
   `origin_connection_limit` = 5.
2. #33 measures CPU saturation or lock waits near `lock_timeout` under
   representative concurrent submissions.

Changing `max_connections` needs a restart, so read it before the first
deployment rather than tuning it under load.

### PostgreSQL version

The schema uses `uuidv7()` as a column default, which needs PostgreSQL 18.
#15 must create the cluster on PostgreSQL 18. That PlanetScale offers 18 in
`ap-southeast` was not checked.

### Branch strategy

- **`main` is the production branch.** It holds the demo data. Migrations run
  against it with the migration role.
- **Development branches are optional and not required.** Local development
  and CI use local PostgreSQL. PlanetScale does not publish the compute price
  of a development branch, and development branches include only 10 GB of
  egress, so none is planned. Create one only for a specific rehearsal, and
  delete it afterwards.

### Estimated monthly cost

Built only from the cited PlanetScale figures:

| Item                      | Estimate                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Cluster, PS-5 single node | $5/month                                                                                                                  |
| Storage                   | $0: 10 GB included per cluster; the demo data is far smaller                                                              |
| Backups                   | $0 while backups stay within 2x the disk size; then $0.023 per GB-month                                                   |
| Egress                    | $0 within the 10 GB/month included with PS-5 without HA; a demo's JSON responses are far below it                         |
| **Estimate**              | **$5 per month**, prorated: PlanetScale bills to the millisecond, so a demo deleted after two weeks costs about half that |

Excluded from the estimate, because this record has no cited figure for them:

- Cloudflare charges: the Workers plan (Free or Paid) and any Hyperdrive
  charge. The Free plan's 10 ms CPU limit may force the Paid plan (see
  [#33](#remaining-approvals-and-verification-for-33)).
- Whether billing through the Cloudflare account changes the PlanetScale
  price.
- HA ($15), development branches, and usage beyond the included
  storage, backup and egress allowances.
- The OTLP backend or collector, if one is used, and the R2 state bucket.
- Taxes.

**The budget decision is the user's.** This estimate is an input to it, not a
budget.

## Hyperdrive

### One configuration, caching disabled

The Worker has one Hyperdrive configuration, bound as `HYPERDRIVE`, used by
every ordering path (`POST /api/v1/orders/verify` and `POST /api/v1/orders`).
Its query caching is **disabled**.

- Hyperdrive caches reads by default (`max_age` 60 s,
  `stale_while_revalidate` 15 s) and does not invalidate cached reads when the
  application writes.
- Verification reads warehouse stock outside a transaction. Cached, it could
  return stock up to about 75 s old, and an estimate could say `valid: true`
  after the stock was sold.
- The submission path's first lookup of a submission key also runs outside a
  transaction. Cached, a replay could miss the accepted Order. The
  transaction re-reads the key under the row locks, so the replay would still
  return the original Order, but only after locking the warehouses for no
  reason.
- Disable it with `--caching-disabled` in Wrangler, or
  `caching = { disabled = true }` on `cloudflare_hyperdrive_config` in the
  Terraform provider v5. #15 uses the Terraform form and sets it explicitly,
  not by relying on a default.

Any cached configuration added later must be a **separate** configuration
with its own binding. It must never serve stock reads, estimate reads or
submission-key lookups. No current path qualifies for it.

### Origin

The Worker never sees a PlanetScale address. It reads only the `HYPERDRIVE`
binding's `connectionString`. The Hyperdrive configuration's origin is
whatever Cloudflare's PlanetScale integration or #15 sets. This design takes
no position on that origin, including whether it goes through PlanetScale's
PgBouncer. The application works either way: both Hyperdrive and PgBouncer
pool in transaction mode, and the application keeps no session state (see
[Transaction pooling](#transaction-pooling-and-submission-semantics)).

### TLS

- Hyperdrive's default is `sslmode=require`: TLS is required and the server
  certificate is validated against WebPKI. That is the starting point.
- `verify-full` additionally checks the hostname and needs a CA certificate
  uploaded (`wrangler cert upload certificate-authority`) and the
  configuration set to `--sslmode verify-full` (in Terraform,
  `mtls = { ca_certificate_id, sslmode }`). It is optional hardening for #15.
- The migration role connects from GitHub Actions directly, with at least
  `sslmode=require` in its connection string.

### Runtime role

- A dedicated role for Hyperdrive, created by #15's bootstrap with
  `--inherited-roles pg_read_all_data,pg_write_all_data`, as Cloudflare's
  PlanetScale guide recommends. It is never the default administrative role.
- It needs `SELECT`, `INSERT` and `UPDATE` on the application tables.
  `FOR UPDATE` needs `UPDATE`. Both predefined roles cover every table, including
  tables added by later migrations, so no grant follows a migration.
- It has no DDL rights. Its password is Hyperdrive's origin credential: it
  lives in the Hyperdrive configuration and the Terraform state, never in the
  Worker or `wrangler.jsonc`.

## Transaction pooling and submission semantics

In transaction mode, Hyperdrive gives a client one origin connection for the
length of a transaction (or of one statement outside a transaction) and
resets the connection when it returns to the pool. The submission store
(`packages/persistence/src/submission-store.ts`) keeps all its state inside
one transaction, so its semantics are unchanged:

- **`FOR UPDATE` row locks.** Row locks last until the transaction ends, and
  the whole transaction runs on one origin connection. Locking all six
  warehouse rows in id order still serializes submissions and prevents
  overselling.
- **READ COMMITTED.** Prisma sets the isolation level on each transaction it
  starts, not as a session default, so it applies whatever connection the
  transaction gets.
- **Timeouts.** `lock_timeout` and `statement_timeout` are set with
  `set_config(..., true)`, the function form of `SET LOCAL`. They end with the
  transaction and never reach the next client of that connection. Cloudflare
  documents that `SET` inside a transaction works.
- **Retry classification.** Transient failures are PostgreSQL SQLSTATEs
  (`40001`, `40P01`, `55P03`, `57014`) and Prisma's `P2034` and two `P2028`
  variants (`packages/persistence/src/submission-errors.ts`). They come from
  the origin or from Prisma, not from the pooler, so they classify the same.
  A failed attempt rolls back entirely, and the next attempt starts a new
  transaction on whatever connection Hyperdrive gives it.
- **Idempotency.** The submission key is a unique constraint, enforced by the
  database whatever the connection.
- **Prepared statements.** Hyperdrive supports node-postgres named prepared
  statements. PrismaPg sends unnamed ones, so nothing depends on either.

Forbidden, because a pooled connection does not keep it:

- Session-level `SET` or `set_config(..., false)`, and any reliance on a
  session default the application set.
- Session-level advisory locks (`pg_advisory_lock`), `LISTEN`/`NOTIFY`,
  temporary tables, and cursors `WITH HOLD` used across transactions.
- Assuming two transactions, or two statements outside a transaction, share a
  connection or a backend (`pg_backend_pid()`).
- Splitting one unit of work across transactions and relying on locks or
  settings carrying over.

Evidence:

- `packages/persistence/test/transaction-pooling.integration.test.ts`
  simulates transaction pooling against real PostgreSQL: a pool of one
  connection, reset with `DISCARD ALL` at every checkout after first
  recording what the previous user left behind, on a database whose default
  isolation is SERIALIZABLE. It checks that no setting outlives the
  transaction and that locks, isolation and retries still behave.
- `packages/persistence/src/session-state.test.ts` checks the same rules at
  unit level.
- Both land with this record. Neither uses a real Hyperdrive; #33 repeats
  the check through one.
- A one-connection pool catches state leaking from one transaction into
  the next. It cannot catch the opposite mistake, code that assumes two
  transactions share a backend (for example through `pg_backend_pid()`),
  which is forbidden above.

Unverified: whether a Hyperdrive-side failure (origin unreachable, pool
exhausted) reaches Prisma as one of the transient classes above. If it does
not, it surfaces as an unexpected error (`500`), which is safe (nothing
commits) but not retried. #33 should record what it observes.

## Timeouts against Hyperdrive's limits

| Setting                                     | Value     | Hyperdrive limit                  | Result                                                                                     |
| ------------------------------------------- | --------- | --------------------------------- | ------------------------------------------------------------------------------------------ |
| `statement_timeout` = transaction `timeout` | 15 s      | 60 s maximum query duration       | A statement is cancelled by PostgreSQL (`57014`, transient) long before Hyperdrive's limit |
| `lock_timeout`                              | 10 s      | 60 s                              | A lock wait fails as `55P03` (transient), below the transaction timeout                    |
| Prisma `maxWait`                            | 5 s       | not applicable (Worker-side pool) | Nothing started; transient                                                                 |
| pg `connectionTimeoutMillis` to Hyperdrive  | 5 s       | 15 s initial origin connect       | A slow cold origin connect fails on our side first, before any statement; transient        |
| Submission attempts                         | 3         | per query, not per request        | At most 3 transactions of at most 15 s each                                                |
| Idle connection                             | none held | 10 min idle timeout               | The Worker closes its connection after each request                                        |

## Connection budget

- **Per request.** The Worker creates a pg `Pool` of at most
  `WORKER_REQUEST_MAX_CONNECTIONS = 2` per request
  (`apps/api/src/composition/worker.ts`). A request's queries run one after
  another, so it holds **at most one** client connection to Hyperdrive; the
  second is headroom. Both are well under Workers' six simultaneous
  connections per request. Client connections to Hyperdrive are unlimited.
- **At the origin.** Hyperdrive holds an origin connection only for a
  transaction or a single statement. The origin connection count across all
  isolates is bounded by the configuration's `origin_connection_limit`
  (minimum 5; a soft maximum of about 20 on Workers Free and about 100 on
  Paid).
- **Rule.**
  `origin_connection_limit ≤ max_connections − reserved − headroom`, where `reserved` is what PlanetScale keeps for
  itself (read from the Parameters tab with `max_connections`), and the
  headroom covers `prisma migrate deploy`, the seed job and an operator
  session (plan on at least 3). Cloudflare's limit is soft, so keep a margin
  below the database's own limit rather than matching it.
- **Recommended start: 5**, the minimum. Submissions serialize on the
  warehouse row locks, so more origin connections only let more transactions
  wait on those locks while each holds a connection. Verification reads are
  single statements and release their connection at once.
- **Measurement is #33's.** #33 measures origin connections, queueing and
  lock waits under representative concurrent requests, and revisits the
  value. It must stay within the rule.

## Worker runtime

#28's runtime criteria are implemented (#35, with #17's telemetry). Pointers:

| Criterion                                    | Where                                                                                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workers entry over the same Hono composition | `apps/api/src/entrypoints/worker.ts`, `apps/api/src/composition/worker.ts`; the Node entry is unchanged                                                             |
| Prisma 7 over the Hyperdrive binding         | `@prisma/adapter-pg`, the `workerd` build of `@scos/persistence`, `nodejs_compat`, `compatibility_date` `2026-08-15` (`apps/api/wrangler.jsonc`)                    |
| Per-request client                           | A pg `Pool` (at most 2) and a Prisma client per request, released under `ctx.waitUntil`; see [observability.md](observability.md#database-prisma-7-over-hyperdrive) |
| Configuration                                | `parseWorkerConfig`, once per isolate; `DATABASE_URL` from the binding; sanitized failures ([observability.md](observability.md#configuration))                     |
| Bundle                                       | See below                                                                                                                                                           |
| Local tests without an account               | `pnpm --filter @scos/api test:workers`, and `test:integration` against local PostgreSQL ([observability.md](observability.md#tests))                                |
| Telemetry flush                              | `ctx.waitUntil`, bounded ([observability.md](observability.md#flush-limits-and-subrequests))                                                                        |

**Bundle, measured on `75e30db`** with `wrangler deploy --dry-run` (Wrangler
4.124.0): **5,515.37 KiB uncompressed, 1,538.44 KiB gzip**, against the
Workers limit of 64 MiB uncompressed. `worker.bundle.test.ts` fails the build
above an 8 MiB budget.

## Inputs for #15

| Input                     | Value                                                                                                                                                                                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Region                    | `ap-southeast` (AWS Singapore)                                                                                                                                                                                                                                              |
| Cluster size              | PS-5, single node                                                                                                                                                                                                                                                           |
| HA                        | No (single node)                                                                                                                                                                                                                                                            |
| PostgreSQL version        | 18 (the schema uses `uuidv7()`); confirm availability                                                                                                                                                                                                                       |
| Branch                    | `main` as production; no development branch                                                                                                                                                                                                                                 |
| Runtime role              | Dedicated, `--inherited-roles pg_read_all_data,pg_write_all_data`; TLS required                                                                                                                                                                                             |
| Migration role            | Separate. `prisma migrate deploy` creates and alters tables, indexes, a trigger function and triggers in `public`, and writes `_prisma_migrations`. It needs `CREATE` on `public` and ownership of those objects. #15 confirms which PlanetScale inherited roles grant that |
| Migration connection      | Direct to the branch host on 5432, never through Hyperdrive; `sslmode=require` or stricter                                                                                                                                                                                  |
| Hyperdrive origin         | As set by Cloudflare's PlanetScale integration or #15, with the runtime role; the application does not depend on the host or port                                                                                                                                           |
| TLS / `sslmode`           | `require` (default, WebPKI validation); `verify-full` with an uploaded CA is optional                                                                                                                                                                                       |
| Caching                   | `caching = { disabled = true }`, set explicitly                                                                                                                                                                                                                             |
| `origin_connection_limit` | 5, within the [budget rule](#connection-budget)                                                                                                                                                                                                                             |
| Hyperdrive ID             | Terraform output, injected into the `HYPERDRIVE` binding by the pipeline before `wrangler deploy` (or a committed non-secret ID); #15 documents which. `wrangler.jsonc` keeps its placeholder                                                                               |
| Placement hint            | Optional: `"placement": { "region": "aws:ap-southeast-1" }` is Cloudflare's recommendation for a Worker beside its database. Not added to `wrangler.jsonc`: its effect on `wrangler dev` is undocumented, and whether it needs a paid plan is unverified. #15 decides       |

## Remaining approvals and verification for #33

Approvals, all the user's:

- The monthly budget (see [estimated monthly cost](#estimated-monthly-cost)).
- The Cloudflare account and the PlanetScale organization.
- Explicit provisioning authorization: completing the deploy settings. Every
  merge to `main` deploys with no approval or enable flag, so the next merge
  after that creates the database and starts billing
  ([ADR 0005 amendment](adr/0005-cloudflare-first-deployment.md#amendment-2026-09-19-the-deploy-creates-the-database)).

Verification, hosted:

- Read `max_connections` and the reserved connections from the Parameters tab
  and check the [budget rule](#connection-budget) before the first deploy.
- The connection budget and lock contention under representative concurrent
  submissions through Hyperdrive: origin connections, waits, `55P03`
  and retry counts, latency.
- Transaction-pooling semantics through a real Hyperdrive, and how its own
  failures are classified.
- CPU per request against the Free plan's 10 ms limit, with a Prisma client
  created per request.
- Workers Logs ingestion of the JSON log records.
- With the collector down, the deployed Worker's logs show only the
  `OpenTelemetry export failed` warnings: no `Network connection lost`
  uncaught exception and no cancelled-`waitUntil` warning.

## Sources

Checked on 2026-09-19.

- [How Hyperdrive works](https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/)
- [Hyperdrive connection pooling](https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/)
- [Hyperdrive limits](https://developers.cloudflare.com/hyperdrive/platform/limits/)
- [Tune the Hyperdrive connection pool](https://developers.cloudflare.com/hyperdrive/configuration/tune-connection-pool/)
- [Hyperdrive query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)
- [Terraform `cloudflare_hyperdrive_config` (provider v5)](https://raw.githubusercontent.com/cloudflare/terraform-provider-cloudflare/main/docs/resources/hyperdrive_config.md)
- [Hyperdrive TLS/SSL certificates](https://developers.cloudflare.com/hyperdrive/configuration/tls-ssl-certificates-for-hyperdrive/)
- [Workers placement](https://developers.cloudflare.com/workers/configuration/placement/)
- [Hyperdrive with PlanetScale Postgres](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/planetscale-postgres/)
- [PlanetScale regions](https://planetscale.com/docs/plans/regions)
- [PlanetScale pricing, `ap-southeast`](https://planetscale.com/pricing?region=ap-southeast)
- [PlanetScale Postgres pricing](https://planetscale.com/docs/postgres/pricing)
- [PlanetScale PgBouncer](https://planetscale.com/docs/postgres/connecting/pgbouncer)
- [Connecting to PlanetScale Postgres](https://planetscale.com/docs/postgres/connecting)
