# Hosted demonstration: the live Cloudflare deployment

This is the evaluator-facing record for #33: where the demonstration runs,
what it is made of, what it costs, what it does not prove, and how to take it
down. The pipeline that produced it is in
[deployment pipeline](deployment-pipeline.md) and
[PlanetScale bootstrap](planetscale-bootstrap.md); the design it follows is in
[Cloudflare deployment design](cloudflare-deployment-design.md) and
[ADR 0005](adr/0005-cloudflare-first-deployment.md).

## Scope and status

- **Provisioned and live.** The other deployment documents describe the
  pipeline as offline preparation. That is no longer true: the database, the
  Hyperdrive configuration and the Worker exist, and PlanetScale has been
  billing since [2026-09-19T18:36:27Z](#the-chargeable-step-and-its-date).
- **Checked on 2026-09-20.** Every measurement below names the command that
  produced it or the workflow run whose log holds it. Anything that could not
  be checked is listed in [what is not verified](#what-is-not-verified), not
  presented as a pass.
- **Single samples, no targets.** Every latency figure here is client-side
  wall clock from one machine over the public internet, not a server-side
  benchmark: individual `curl` timings under
  [evaluator access](#evaluator-access), and `scripts/hosted-concurrency.mjs`
  under [concurrency](#concurrency-connection-budget-and-latency). No latency
  or throughput target is agreed
  ([README limitations](../README.md#limitations-and-next-steps)).
- **Nothing here was torn down.** [Teardown](#teardown) is a procedure, not a
  report: executing it needs its own explicit authorization.
- **Secrets.** No token, password or credentialed connection string appears
  in this document. Role names, the Cloudflare account ID and the Hyperdrive
  configuration ID are not credentials
  ([the state is a secret](deployment-pipeline.md#the-state-is-a-secret)).

## Evaluator access

The API is **public and unauthenticated**. Anyone who has the URL can verify
and submit orders; a `submissionId` is a retry key, not a credential
([README](../README.md#limitations-and-next-steps)). There is nothing to log
in to and no key to request.

| Entry point                                                  | What it is                        | Checked 2026-09-20                                                        |
| ------------------------------------------------------------ | --------------------------------- | ------------------------------------------------------------------------- |
| `https://scos-api.bonanaaaaaa-scos.workers.dev/docs`         | Swagger UI, "Try it out" enabled  | `200`, `text/html; charset=UTF-8`                                         |
| `https://scos-api.bonanaaaaaa-scos.workers.dev/openapi.json` | The OpenAPI 3.1.0 document        | `200`, 47,455 bytes                                                       |
| `https://scos-api.bonanaaaaaa-scos.workers.dev/health`       | Liveness                          | `200`, `{"status":"ok"}`                                                  |
| `POST /api/v1/orders/verify`                                 | Advisory estimate; writes nothing | `200` (see [demonstration data](#demonstration-data))                     |
| `POST /api/v1/orders`                                        | Submission; **consumes stock**    | `201`; exercised 46 times (see [demonstration data](#demonstration-data)) |

Commands an evaluator can repeat:

```sh
base=https://scos-api.bonanaaaaaa-scos.workers.dev
curl -s "$base/health"
curl -s -o /dev/null -w '%{http_code} %{size_download} bytes %{time_total}s\n' "$base/openapi.json"
curl -s -X POST "$base/api/v1/orders/verify" -H 'content-type: application/json' \
  -d '{"quantity":150,"latitude":52.52,"longitude":13.405}'
```

Observed on 2026-09-20 from one client: `/health` 0.67 s on the first request
of the session and 0.12 s on a later one; `/openapi.json` 0.32 s;
`/api/v1/orders/verify` 0.17-0.31 s across three requests. The OpenAPI
document declares `servers: [{ "url": "/" }]`, so Swagger UI's "Try it out"
targets the same host it was loaded from.

**Before submitting an order**, read
[demonstration data](#demonstration-data): stock is finite and never
replenished.

## What is deployed

| Fact               | Value                                                                    |
| ------------------ | ------------------------------------------------------------------------ |
| Worker             | `scos-api`                                                               |
| Version ID         | `fcd23e34-10cb-44d5-8ebf-9bd286286934`                                   |
| Built from         | `main@63f5cc7` ("feat(api): trace the deployed Worker ... (#46)")        |
| Deployed by        | `Deploy Prod` run 35464751718, triggered by a push, 2026-09-19T19:34:17Z |
| Health check in it | "Healthy after 1 attempt(s)" at 19:35:33Z                                |

The version ID and the health line are in that run's log (`wrangler deploy`
prints `Current Version ID:`). `wrangler deployments list --name scos-api`
shows the same from an account login.

## Resource inventory

### Cloudflare

| Resource                 | Identity                                                                                      | Managed by                                 |
| ------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Account                  | `4ad99c6b32b92ce7684f23ab6ca8155f` (`prod` variable `CLOUDFLARE_ACCOUNT_ID`)                  | The user                                   |
| Worker                   | `scos-api`                                                                                    | Wrangler, `apps/api/wrangler.jsonc`        |
| `workers.dev` subdomain  | `bonanaaaaaa-scos.workers.dev`                                                                | Account-level; pre-existing (see below)    |
| Hyperdrive configuration | `cloudflare_hyperdrive_config.scos`, named `scos-prod`, ID `78cbd0b0c76b42589966b3facc8e880c` | Terraform, `infra/cloudflare/main.tf`      |
| R2 state bucket          | `bonanaaaaaa-scos-ac4c2d32-tfstate`, key `scos/prod/terraform.tfstate`                        | Created by hand, outside Terraform         |
| R2 state backups         | `scos/prod/state-backups/terraform.tfstate.<UTC time>.<label>`, newest 10 kept                | `infra/cloudflare/scripts/state-backup.sh` |

- **One Hyperdrive configuration, caching disabled, `origin_connection_limit`
  = 5.** `infra/cloudflare/variables.tf:83-92` defaults the limit to 5 and
  rejects anything outside 5-20, and no `prod` or repository variable
  overrides it: `gh variable list --env prod` returns only
  `CLOUDFLARE_ACCOUNT_ID` and the five `TF_STATE_*` names, and the deploy
  passes no `TF_VAR_origin_connection_limit`. The latest deploy's apply
  reported `no-op cloudflare_hyperdrive_config.scos` and "Apply complete!
  Resources: 0 added, 0 changed, 0 destroyed", so the live configuration
  matches the committed one, including `caching = { disabled = true }`.
- **The subdomain was not chosen by the pipeline.** The deploy's
  "Ensure a workers.dev subdomain" step would have registered
  `scos-bonanaaaaaa` (its default is `scos-<repository owner>`, and
  `WORKERS_DEV_SUBDOMAIN` is unset), but the first run of that step logged
  "workers.dev subdomain already registered: bonanaaaaaa-scos.workers.dev"
  (run 35463180610, 19:05:17Z). The subdomain therefore predates the
  pipeline, is account-level, and is not removed by
  [teardown](#teardown). `https://scos-api.scos-bonanaaaaaa.workers.dev/health`
  does not resolve, which confirms only one of the two names exists.

### PlanetScale

| Fact                     | Value                                                                  |
| ------------------------ | ---------------------------------------------------------------------- |
| Organization             | `bonanaaaaaa` (repository variable `PLANETSCALE_ORG`)                  |
| Database                 | `scos`                                                                 |
| Branch                   | `main` (production)                                                    |
| Region                   | `ap-southeast` (AWS Singapore)                                         |
| Cluster                  | PS-5, single node, 0 replicas                                          |
| Engine                   | PostgreSQL 18                                                          |
| Branch host              | `ap-southeast-2.pg.psdb.cloud:5432`                                    |
| PostgreSQL database name | `postgres` (not `scos`)                                                |
| Schema                   | `20260918000000_initial_ordering_schema`, applied 2026-09-19T18:52:08Z |
| Runtime role             | `scos_runtime`, inherits `pg_read_all_data,pg_write_all_data`          |
| Migration role           | `scos_migrator`, inherits `postgres`                                   |

The database, branch, region and cluster size are the bootstrap script's
defaults ([inputs](planetscale-bootstrap.md#inputs)); none of the
corresponding `prod` variables is set, and the creation log line names the
values PlanetScale was asked for. The host is the value the bootstrap
published to the job summary and `$GITHUB_ENV` (`BOOTSTRAP_PLANETSCALE_HOST`)
on every run.

- **`scos_runtime` is Hyperdrive's origin credential.** Its password lives in
  the Hyperdrive configuration and the Terraform state, never in the Worker.
- **`scos_migrator` is used only by `prisma migrate deploy` and the seed**,
  over a direct connection to the branch host on 5432, never through
  Hyperdrive
  ([migration connection](cloudflare-deployment-design.md#inputs-for-15)). Its
  password was rotated once, by run 35462498113
  (`rotate_credentials: migration`, "Plan: database=keep, runtime role=keep,
  migration role=reset").

### GitHub

| Setting                                                                                                                         | Level                        |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `CLOUDFLARE_API_TOKEN`                                                                                                          | `prod` environment secret    |
| `PLANETSCALE_SERVICE_TOKEN`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`                                                         | Repository secrets           |
| `CLOUDFLARE_ACCOUNT_ID`, `TF_STATE_BUCKET`, `TF_STATE_ENDPOINT`, `TF_STATE_KEY`, `TF_STATE_REGION`, `TF_STATE_WORKSPACE_PREFIX` | `prod` environment variables |
| `PLANETSCALE_ORG`, `PLANETSCALE_SERVICE_TOKEN_ID`                                                                               | Repository variables         |

Verified with `gh secret list`, `gh secret list --env prod`,
`gh variable list` and `gh variable list --env prod` on 2026-09-20. The split
is the one [Credentials](deployment-pipeline.md#credentials) describes: only
the Cloudflare token is an environment secret.

- **The role credentials are not GitHub secrets.** The runtime password and
  the migration URL live only in the Terraform state
  ([role credentials in the state](deployment-pipeline.md#role-credentials-in-the-state)).
  This is a [documented deviation](#deviations-from-33s-wording) from #33's
  "no credentials outside GitHub environment secrets".
- **`prod` has no protection.** `gh api repos/bonanaaaaaa/scos/environments/prod`
  returns `protection_rules: []` and `deployment_branch_policy: null` on
  2026-09-20: no required reviewers, and the deployment-branch restriction
  that the [operator checklist](deployment-pipeline.md#operator-checklist)
  asks for as its first step is still not set.
- **`Deploy Prod` is enabled.** `gh workflow list --all` shows it `active` on
  2026-09-20, so the next push to `main` redeploys — and, after a teardown,
  would recreate the database. See [teardown](#teardown).

## Billing

### The chargeable step and its date

**The PlanetScale `scos` database was created on 2026-09-19T18:36:27Z and has
been billing since.** It bills from creation until deletion whether or not it
is used, and [deleting it](#teardown) is the only thing that stops the charge.

It was created by **`Deploy Prod` run 35460411214, triggered by a push to
`main`** (the merge of "fix(ci): show Wrangler's error when the billing
signature fails (#43)", run started 18:35:37Z). Its log holds:

- 18:36:26Z `Plan: database=create, runtime role=create, migration role=create.`
- 18:36:27Z `Creating PostgreSQL database scos in ap-southeast (PS-5, 0 replicas, PostgreSQL 18), billed to Cloudflare account 4ad99c6b32b92ce7684f23ab6ca8155f.`
- 18:38:41Z `Created database scos.`
- 18:38:42Z / 18:38:45Z the two roles.

The run then failed while storing the migration role's credential, which is
why later runs appear in the [timeline](#deployment-timeline); the database
survived that failure. An earlier attempt, run 35459962227 at 18:04:05Z,
stopped before creating anything (`wrangler hyperdrive planetscale signature
failed`), so it left no database behind and started no billing.

### Deviations from #33's wording

Two of #33's criteria describe a process that the repository has since
replaced by decision. They are recorded here as deviations, not defects.

1. **"A person triggers #15's bootstrap workflow once ... nothing triggered
   by a push or a merge creates the database."** The database was created by
   a push-triggered deploy, as described above.
   `planetscale-bootstrap.yml` has **never been dispatched**
   (`gh run list --workflow=planetscale-bootstrap.yml` is empty on
   2026-09-20). This follows ADR 0005's
   [2026-09-19 amendment](adr/0005-cloudflare-first-deployment.md#amendment-2026-09-19-the-deploy-creates-the-database),
   written after #33 was filed: "During #15 the user chose to fold creation
   into the deployment, so a merge to `main` provisions everything a deploy
   needs in one run." The same amendment records that "the `prod` environment
   has no required reviewers, by the user's choice", which removes the
   environment approval #33 names as the authorization gesture.

   **Practical difference:** the authorization was still explicit and still
   the user's, but it was _completing the `prod` deploy settings and merging_
   rather than _dispatching a workflow and approving an environment_. Nothing
   asked a second time at the moment of creation, and the kill switch is
   disabling `Deploy Prod` rather than declining an approval.

2. **"no credentials outside GitHub environment secrets."** The two
   PlanetScale role credentials live in the Terraform state in R2, by the
   same amendment's decision ("the deploy stores both role credentials in the
   Terraform state in the same run, by the user's choice, instead of GitHub
   secrets"). The state is treated as a secret and backed up before every
   apply
   ([the state is a secret](deployment-pipeline.md#the-state-is-a-secret)).

### Estimated cost

No actual charge was read. The only figure available is the estimate in
[estimated monthly cost](cloudflare-deployment-design.md#estimated-monthly-cost):
**$5 per month** for the PS-5 single-node cluster in `ap-southeast`,
prorated, with $0 expected for storage, backups and egress inside the
included allowances. That record excludes Cloudflare's own charges (the
Workers plan and any Hyperdrive charge), whether billing through the
Cloudflare account changes the PlanetScale price, the R2 state bucket, and
taxes. Elapsed cost can be computed from the creation date above: at $5 per
30-day month the cluster accrues roughly $0.17 per day.

### Actual charges: an open gap

**Not recorded.** #33 asks for actual charges and they were not obtainable
while producing this document: the Cloudflare MCP access available to this
project is bound to a different Cloudflare account, and no PlanetScale
credentials were available, so neither the Cloudflare billing view nor
PlanetScale's usage page could be read. Per #33's own rule, that is blocked,
not implicitly complete.

To close it, the user (or anyone with the account) reads both, because the
database is billed through Cloudflare:

1. Cloudflare dashboard > the account `4ad99c6b32b92ce7684f23ab6ca8155f` >
   Billing > Billing history / Usage, for the PlanetScale line item, the
   Workers plan and any Hyperdrive charge.
2. PlanetScale dashboard > organization `bonanaaaaaa` > the `scos` database >
   Usage, for the cluster's accrued cost and any storage, backup or egress
   overage.

Record the figure, the period it covers and the date read.

## Demonstration data

The demo data was seeded **once**, by `Deploy Prod` run 35463375940
(`workflow_dispatch` with `seed_demo_data: true`). Its log, at
2026-09-19T19:09:19Z: "Seeded warehouses: 6 inserted, 0 already present (stock
unchanged)."

**Stock is finite and is never replenished.** The seed inserts missing
warehouses with `ON CONFLICT (id) DO NOTHING` and never updates an existing
row (`packages/persistence/src/seed.ts`), so re-running it reports
"0 inserted, 6 already present" and restores nothing. There is no reset path
in the pipeline. Every accepted order permanently reduces the demonstration's
budget of orderable units.

The figures below are **as of the end of this record's verification work**,
which itself consumed 47 units. They are a snapshot, not a constant: the
deployment is public, so anyone may have spent more since. Re-read the live
total with the method below before relying on it.

| Warehouse   | Seeded stock | Available, after verification (2026-09-20) | Consumed |
| ----------- | ------------ | ------------------------------------------ | -------- |
| Los Angeles | 355          | 355                                        | 0        |
| New York    | 578          | 574                                        | 4        |
| São Paulo   | 265          | 265                                        | 0        |
| Paris       | 694          | 651                                        | 43       |
| Warsaw      | 245          | 95                                         | 150      |
| Hong Kong   | 419          | 419                                        | 0        |
| **Total**   | **2,556**    | **2,359**                                  | **197**  |

Method: the seeded column is `warehouseSeeds` in
`packages/persistence/src/seed.ts`. The available column is read from the
live API without writing anything: `POST /api/v1/orders/verify` with
`quantity` 2,359 returns `SHIPPING_EXCEEDS_LIMIT` with a full six-warehouse
allocation, which lists each warehouse's remaining stock, while 2,360 returns
`INSUFFICIENT_STOCK` with no allocation. 2,359 is therefore the exact total
available. Re-run it for the current figure:

```sh
curl -s -X POST https://scos-api.bonanaaaaaa-scos.workers.dev/api/v1/orders/verify \
  -H 'content-type: application/json' \
  -d '{"quantity":2359,"latitude":49.009722,"longitude":2.547778}'
```

All 197 consumed units are accounted for:

- **150 from Warsaw, before this record's work.** Consistent with a single
  accepted order of quantity 150 destined for (52.52, 13.405) — the
  `accepted` example in the OpenAPI document, which is what Swagger UI's
  "Try it out" sends unedited — because Warsaw is the nearest warehouse to
  that destination and had 245 units. The Order record itself was not read
  (no database access), so this provenance is an inference, not a verified
  fact. It is the only consumption here that is not.
- **43 from Paris**, by `scripts/hosted-concurrency.mjs` across the five runs
  in [concurrency](#concurrency-connection-budget-and-latency).
- **4 from New York**, by four runs of the hosted acceptance suite at one
  unit each ([hosted API acceptance](#hosted-api-acceptance)); its accepted
  order ships to Manhattan, whose nearest warehouse is New York.

Notes for an evaluator who wants to submit:

- The `accepted` example uses a fixed `submissionId`
  (`checkout-7f3a-attempt-1`). Submitting it again returns the original Order
  and consumes nothing more
  ([ADR 0004](adr/0004-deduplicate-accepted-orders.md)); changing the
  quantity under the same `submissionId` returns `409`. Only a **new**
  `submissionId` consumes stock.
- `POST /api/v1/orders/verify` never writes, so estimates, rejection reasons,
  decimal formatting and the allocation rules can be explored as often as
  wanted at no cost to the stock.
- The README's `curl` amounts assume freshly seeded stock and no longer match
  ([open risks](acceptance-evidence.md#open-risks)).

## Verification evidence

The hosted checks for #33 are produced separately and merged into this
section.

### Hosted API acceptance

Produced by the QA-owned suite
`apps/api-acceptance/test/hosted/acceptance.hosted.test.ts` against
`https://scos-api.bonanaaaaaa-scos.workers.dev` on 2026-09-20.
**33 tests, all passing**, in about 15 s. Re-run it with:

```sh
pnpm install
HOSTED_BASE_URL=https://scos-api.bonanaaaaaa-scos.workers.dev \
  pnpm --filter @scos/api-acceptance run test:hosted
```

It is a **black box over HTTP and nothing else**. It shares the oracle with
the rest of [`apps/api-acceptance`](../apps/api-acceptance/README.md) but
deliberately does not use that app's `API_BASE_URL` external mode, which
migrates, seeds and wipes the database it is pointed at — against this
deployment that would destroy the demonstration data and reset stock, which
#33 forbids. The hosted suite reads its target from its own
`HOSTED_BASE_URL`, opens no database connection, and loads no global setup.

It costs **exactly 1 unit of stock per run** (one accepted one-unit Order to
Manhattan, chosen so shipping is a real rounded charge rather than `0.00`).
Every other scenario is free: verification stores nothing, and a 400, 409 or
422 consumes neither stock nor a `submissionId`
([ADR 0004](adr/0004-deduplicate-accepted-orders.md)). The figure was
confirmed by bisecting the hosted total either side of a run
(2,404 → 2,403), not merely asserted inside the suite.

| #33's criterion           | Covered by                                                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Health                    | `GET /health` → `200`, `{"status":"ok"}`, as JSON                                                                                                                                                      |
| Estimates                 | Every amount and allocation matched against an independent oracle written from the PRD, plus all eight discount tiers (24/25/49/50/99/100/249/250) and a zero-distance destination shipping `0.00`     |
| Acceptance                | `201` with exactly the documented key set, an `SO-` + 12-character Crockford base32 order number, the oracle's amounts, and the named warehouse's stock actually deducted                              |
| Rejection                 | `422 INSUFFICIENT_STOCK` and `422 SHIPPING_EXCEEDS_LIMIT` (each returning the estimate that caused it), and `400 INVALID_REQUEST` over seven malformed cases; none consumed stock                      |
| Retry (idempotent replay) | The same `submissionId` and body returned a **byte-identical** response with the same order number, and the inventory was unchanged either side                                                        |
| Conflict                  | The same `submissionId` with a different quantity, and separately with a different destination, each returned `409 SUBMISSION_ID_CONFLICT` without disclosing the existing order number                |
| Decimal serialization     | Asserted on the **raw response text**, so a JSON number or scientific notation fails rather than being hidden by `JSON.parse`; covers `null` amounts and the largest amounts the contract allows       |
| The OpenAPI document      | `200`, a valid OpenAPI 3.1 document, stable across requests, describing the routes actually served, with every declared response validating a real one; an undocumented route gives the `404` envelope |
| The interactive docs      | `GET /docs` → `200` HTML booting Swagger UI against the specification this deployment serves                                                                                                           |

**No contract mismatch was found on the live deployment.**

How the suite stays honest about the shared, finite inventory:

- **Nothing about stock is hardcoded.** `readStock()` finds the live total by
  an exponential probe and bisection on `INSUFFICIENT_STOCK` through free
  verifications, then derives the per-warehouse breakdown from a single
  verification for exactly that total.
- **The oracle is reused, not rewritten.** The suite imports
  `apps/api-acceptance/test/support/oracle.ts` and `prd.ts` unmodified, and
  makes its requests through that app's shared `http.ts`. Nothing is imported
  from `@scos/core` for expected values, so the deployment is never checked
  against itself. `prd.ts`'s `WAREHOUSES` holds **seed** stock and is never
  treated as current: every oracle call that takes a stock array is handed a
  runtime reading.
- **It tolerates another client.** Read-only comparisons are bracketed by two
  inventory readings and retried until both agree, so an oracle comparison is
  only made over a window in which stock demonstrably did not move; the
  acceptance check falls back to the invariant that survives a concurrent
  consumer (stock is monotonically non-increasing).
- **Missing configuration fails, never skips.** Without a valid
  `HOSTED_BASE_URL` the run exits non-zero with
  `HOSTED_BASE_URL must point at the deployed API`, matching this
  repository's rule that a missing check is a failure rather than a pass
  ([acceptance evidence](acceptance-evidence.md)).
- **CI cannot pick it up.** No `test:hosted` task exists in either
  `turbo.json`, so `turbo run test test:workers` and `test:integration` do not
  resolve it, and it needs a live URL that CI does not have.

> **Do not run this suite and `scripts/hosted-concurrency.mjs` at the same
> time.** Both drive the same deployment, and the acceptance suite fails
> deliberately when another client moves stock inside one of its measurement
> windows.

Not covered here, and left to the suites that can cover it:

| Gap                                                                                     | Why, and who covers it                                                                                                                                          |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Internal transactional invariants: row locking, rollback, stored Order == returned body | Not provable through the HTTP surface; backend-developer integration coverage against real PostgreSQL ([acceptance evidence](acceptance-evidence.md))           |
| The documented `500` and `503` responses                                                | A Hyperdrive or PlanetScale failure cannot be induced from outside the account; exercised by the CI suites only                                                 |
| A genuine multi-warehouse **split acceptance**                                          | Would permanently consume hundreds of units, which #33's no-reset rule forbids. Split allocation is covered free through `verify` at 250 units and at total + 1 |
| Anything needing a known absolute stock level                                           | Absent by design, not by omission: stock is shared and never replenished                                                                                        |

### Concurrency, connection budget and latency

Produced by `scripts/hosted-concurrency.mjs` on 2026-09-20 against
`https://scos-api.bonanaaaaaa-scos.workers.dev`, from one client machine over
the public internet. Five runs; **43 units of stock consumed in total**
(2,403 → 2,360). Every submission is one unit with a fresh
`crypto.randomUUID()` submissionId, so nothing collides and the cost of a run
equals the number of submissions it makes. The probe reads the stock at
runtime through `POST /api/v1/orders/verify` (which writes nothing), never
assumes or restores it, refuses to submit more than `--max-units` (default
15), and has a `--dry-run` mode that measures latency with verifications only
and consumes nothing. The 153 verifications the five runs made, and the 15 the
dry run made, cost no stock.

```sh
# Read-only: latency only, consumes nothing.
node scripts/hosted-concurrency.mjs --dry-run --concurrency 5

# The five runs below, in order. Each submission consumes one unit.
node scripts/hosted-concurrency.mjs --concurrency 1  --submissions 3   # run A
node scripts/hosted-concurrency.mjs --concurrency 5  --submissions 5   # run B
node scripts/hosted-concurrency.mjs --concurrency 15 --submissions 15 --max-units 15  # run C
node scripts/hosted-concurrency.mjs --concurrency 15 --submissions 15 --max-units 15  # run D
node scripts/hosted-concurrency.mjs --concurrency 5  --submissions 5   # run E
```

`--base-url` (or `HOSTED_BASE_URL`) points it elsewhere. A re-run consumes
stock again, and the stock is lower now than the figures below, so re-read
[demonstration data](#demonstration-data) before repeating it.

#### Correctness under contention: no oversell, no lost update

Every run reads the whole inventory immediately before and immediately after
its burst, and compares the units accepted with the stock actually consumed.

| Run   | Burst width    | Submissions | `201` | Any other status | Stock before → after | Consumed | Accepted == consumed |
| ----- | -------------- | ----------- | ----- | ---------------- | -------------------- | -------- | -------------------- |
| A     | 1 (sequential) | 3           | 3     | none             | 2,403 → 2,400        | 3        | yes                  |
| B     | 5              | 5           | 5     | none             | 2,400 → 2,395        | 5        | yes                  |
| C     | 15             | 15          | 15    | none             | 2,395 → 2,380        | 15       | yes                  |
| D     | 15             | 15          | 15    | none             | 2,380 → 2,365        | 15       | yes                  |
| E     | 5              | 5           | 5     | none             | 2,365 → 2,360        | 5        | yes                  |
| **Σ** |                | **43**      | 43    | none             | **2,403 → 2,360**    | **43**   | **yes**              |

Also checked, per run and in total:

| Check                                                     | Result                                                                                  |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Distinct `orderNumber` per accepted order                 | 43 accepted, 43 distinct                                                                |
| Per-warehouse allocations == per-warehouse stock consumed | Matched in all five runs; all 43 units came from Paris (`…0004`), the nearest warehouse |
| `5xx` responses                                           | 0                                                                                       |
| Transport failures (connection reset, DNS, TLS)           | 0                                                                                       |
| `409 SUBMISSION_ID_CONFLICT` / `422` rejections           | 0 (expected: fresh submissionIds, one unit, ample stock)                                |
| `503` with `Retry-After` (every internal attempt failed)  | 0                                                                                       |

How the stock was read: the exact available total is found by an exponential
probe and a bisection on `INSUFFICIENT_STOCK`, then one verification for
exactly that total returns a six-warehouse allocation whose per-warehouse
quantities are the remaining stock — the same technique
[demonstration data](#demonstration-data) describes. A reading whose
allocations do not sum to the total means another client moved the inventory,
and the probe re-reads rather than trusting it.

**No oversell and no lost update were observed at any width**, including two
independent bursts of 15 simultaneous submissions all contending for the same
six row locks.

#### Latency

**These are client-side wall-clock timings from one machine over the public
internet to `ap-southeast`.** Each figure includes DNS, TLS, the round trip to
the Cloudflare edge and Hyperdrive's own hop; none of it is a server-side
benchmark, and no latency target is agreed
([README limitations](../README.md#limitations-and-next-steps)). Percentiles
are nearest-rank over the sample size shown, and a sample of 5 or 15 makes p90
and p99 the same one or two requests — they are reported for shape, not as
stable quantiles.

Low-concurrency baseline, so the contention cost below is a comparison rather
than an absolute:

| Run | Measurement                           | n   | min | p50 | p90 | p99 | max |
| --- | ------------------------------------- | --- | --- | --- | --- | --- | --- |
| A   | `verify`, sequential                  | 12  | 87  | 107 | 155 | 189 | 189 |
| B   | `verify`, sequential                  | 12  | 80  | 107 | 159 | 160 | 160 |
| C   | `verify`, sequential                  | 12  | 78  | 91  | 158 | 172 | 172 |
| D   | `verify`, sequential                  | 12  | 89  | 99  | 146 | 149 | 149 |
| E   | `verify`, sequential                  | 12  | 79  | 89  | 136 | 156 | 156 |
| A   | **submissions**, sequential (width 1) | 3   | 237 | 286 | 410 | 410 | 410 |

All values in milliseconds. A sequential verification is a single statement
that takes no row lock; an uncontended submission is a transaction that locks
all six warehouse rows and writes an Order, and costs roughly 2-3x a
verification.

Bursts. Each submission burst is paired with a **read-only control burst of
the same width in the same run** — concurrent verifications, which carry the
same network, Worker and Hyperdrive cost but take no row lock — so
concurrency cost that is not lock contention is visible separately:

| Run | Width | Measurement          | n   | min | p50 | p90   | p99   | max   |
| --- | ----- | -------------------- | --- | --- | --- | ----- | ----- | ----- |
| B   | 5     | `verify` burst       | 5   | 209 | 220 | 702   | 702   | 702   |
| B   | 5     | **submission burst** | 5   | 208 | 362 | 765   | 765   | 765   |
| E   | 5     | `verify` burst       | 5   | 193 | 224 | 224   | 224   | 224   |
| E   | 5     | **submission burst** | 5   | 189 | 386 | 926   | 926   | 926   |
| C   | 15    | `verify` burst       | 15  | 100 | 155 | 627   | 642   | 642   |
| C   | 15    | **submission burst** | 15  | 167 | 809 | 1,682 | 1,949 | 1,949 |
| D   | 15    | `verify` burst       | 15  | 116 | 164 | 731   | 941   | 941   |
| D   | 15    | **submission burst** | 15  | 194 | 840 | 1,619 | 1,734 | 1,734 |

Submission p50 rises 286 ms (width 1) → 362/386 ms (width 5) → 809/840 ms
(width 15); the read-only control's p50 stays between 155 ms and 224 ms at
both burst widths.

#### Lock contention

The prediction in
[connection budget](cloudflare-deployment-design.md#connection-budget) is that
submissions serialize on the warehouse row locks. Three observations, all
client-side:

1. **Growth with concurrency, weakly evidenced — read observation 2
   instead.** Burst maximum averaged 846 ms at width 5 (765, 926) and
   1,842 ms at width 15 (1,949, 1,734), which works out at about 100 ms per
   additional concurrent submission, against about 33 ms per additional
   request for the read-only control at the same widths (463 ms to 792 ms).
   Extrapolating the submission line back to width 1 predicts 447 ms against
   an observed sequential maximum of 410 ms.
   **This comparison is weaker than it looks and is not load-bearing.** It
   rests on four burst maxima, and the maximum of a sample grows with the
   sample size on its own, so part of the difference between width 5 and
   width 15 is arithmetic rather than contention. It is recorded because it
   points the same way as observation 2, not as independent evidence.
2. **A burst's sorted latencies form an arithmetic progression; the control's
   do not.** Run D, width 15, submissions, ascending (ms):
   `194, 248, 307, 426, 491, 678, 754, 840, 980, 1111, 1229, 1355, 1480, 1619, 1734`
   — successive steps of 54-187 ms, **median 117 ms** on the raw timings,
   which is what one request waiting for one more serialized transaction
   looks like. (Recomputing the median from the rounded values printed above
   gives 118.5 ms; the values are rounded to the millisecond, so a
   recomputation drifts slightly from the figure computed on the raw
   timings. The mean step is omitted deliberately: for a sorted series it is
   just (max − min) / (n − 1), so it would restate the spread in
   observation 3 rather than add evidence.)
   The same run's control burst, ascending:
   `116, 135, 137, 143, 147, 151, 159, 164, 194, 425, 426, 446, 447, 731, 941`
   — median step **7 ms**, three clusters rather than a ramp.
3. **Spread between fastest and slowest in a burst** grew with width: 556 ms
   and 737 ms at width 5, 1,782 ms and 1,540 ms at width 15 (submissions),
   against 494 ms and 31 ms for the width-5 controls and 542 ms and 825 ms for
   the width-15 controls. The fastest request in a
   burst of 15 (167 ms, 194 ms) is as fast as an uncontended one; only the
   ones behind it pay.

Retry and conflict signals observable from outside: **none**. No `503`, no
`Retry-After` header, no `409`, no `5xx`. What that does and does not exclude:

| Signal                                                          | Verdict                                                                                                                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A submission exhausting all attempts (`503` + `Retry-After: 1`) | **Excluded**: 0 of 43                                                                                                                                         |
| A `55P03` lock timeout, then an internal retry                  | **Excluded**: `lock_timeout` is 10 s (`packages/persistence/src/submission-store.ts`) and the slowest submission observed was 1.9 s, so nothing waited it out |
| A `40001`/`40P01`/`P2034` retry that then succeeded             | **Not excluded.** The application retries transient failures internally up to `MAX_SUBMISSION_ATTEMPTS` = 3 and only exhaustion is visible to a client        |
| Transaction or statement timeouts                               | **Excluded** on the same argument: `statement_timeout` and the Prisma transaction timeout are 15 s                                                            |

#### Connection budget

The arithmetic, from the repository rather than from the account:

| Quantity                                                                 | Value | Source                                                                       |
| ------------------------------------------------------------------------ | ----- | ---------------------------------------------------------------------------- |
| `origin_connection_limit`                                                | 5     | `infra/cloudflare/variables.tf`, no override (see [Cloudflare](#cloudflare)) |
| pg pool size per request                                                 | 2     | `WORKER_REQUEST_MAX_CONNECTIONS`, `apps/api/src/composition/worker.ts`       |
| Client connections a request actually holds at once                      | 1     | Its queries run sequentially; the second is headroom                         |
| Client connections to Hyperdrive at burst width 15                       | ≤ 15  | Arithmetic; Hyperdrive does not limit client connections                     |
| Concurrent origin connections that width can reach                       | ≤ 5   | Bounded by `origin_connection_limit`                                         |
| Of those, how many can make progress while one submission holds the lock | 1     | Every submission locks all six warehouse rows in id order                    |

So at width 15 the 5 origin connections are the ceiling, and by the design's
own reasoning at most one of them can be doing work: "more origin connections
only let more transactions wait on those locks while each holds a connection"
([connection budget](cloudflare-deployment-design.md#connection-budget)). The
measured ~110 ms serialization step is consistent with that; it is **not** a
measurement of how many origin connections were open.

What these observations do tell us: 30 submissions across two bursts of 15,
plus 40 verifications fired in concurrent bursts, completed with no `503`, no
`5xx` and no transport failure, and the slowest of them took 1.9 s — so at
these widths nothing in the path exhausted a pool, timed out, or was
rejected. What they do
**not** tell us: the actual origin connection count, whether Hyperdrive
queued, and how close the origin pool came to 5. Those are Hyperdrive
analytics, which need the Cloudflare account.

**The budget rule cannot be closed here.** The rule is
`origin_connection_limit ≤ max_connections − reserved − headroom`, with
`headroom` at least 3 for `prisma migrate deploy`, the seed job and an
operator session. With `origin_connection_limit` = 5 that requires
`max_connections − reserved ≥ 8`. Neither `max_connections` nor PlanetScale's
reserved connections was readable (no PlanetScale credentials), so **whether
5 fits is unverified**. To close it: PlanetScale dashboard → organization
`bonanaaaaaa` → database `scos` → **Parameters** tab; read `max_connections`
and the reserved connection count, and check the inequality. Changing
`max_connections` needs a restart, so read it before tuning anything under
load.

#### What this section did not measure

| Gap                                                                            | Why                                                                                                                                   |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Origin connection counts, Hyperdrive queueing, pool saturation                 | Not observable from a client; needs Hyperdrive analytics on this Cloudflare account                                                   |
| `max_connections`, reserved connections, and therefore the budget rule         | No PlanetScale credentials (above)                                                                                                    |
| Server-side latency, CPU time per request, cold-start share                    | Client-side timings only; CPU time needs the Cloudflare dashboard                                                                     |
| Internal retries that succeeded (`40001`, `40P01`, `P2034`)                    | Invisible to a client; only exhaustion surfaces, as `503`                                                                             |
| Behaviour above width 15, and sustained load                                   | Deliberately not attempted: stock is finite and 43 units were already spent. Each additional concurrent submission costs another unit |
| Stable percentiles                                                             | Sample sizes are 3-15 per burst, bounded by the same stock budget                                                                     |
| How much of the burst growth is the client's own concurrency                   | Partly separated by the same-width read-only control, which also grew (≈33 ms per request); the control is a bound, not a subtraction |
| Whether a different destination or a multi-warehouse order behaves differently | All 43 submissions were one unit destined for the Paris warehouse's own coordinates                                                   |

### Telemetry

**Blocked.** No OTLP collector is configured: no `OTEL_*` variable or
`OTEL_EXPORTER_OTLP_HEADERS` secret exists on the `prod` environment, so the
Worker keeps `OTEL_TRACES_EXPORTER` and `OTEL_METRICS_EXPORTER` at `none`
(`apps/api/wrangler.jsonc`). What is enabled instead is Cloudflare's own
`observability` block: Workers Logs with invocation logs, and Cloudflare's
automatic tracing, which `63f5cc7` turned on precisely because the
application exports no traces of its own. Confirming that the JSON log lines
and the automatic traces actually arrive, and measuring the `ctx.waitUntil`
flush, needs the Cloudflare dashboard for this account, which was not
available ([what is not verified](#what-is-not-verified)).

#33's telemetry criterion has three clauses, and they are not equally blocked.
Two of them already have executable coverage in `workerd` — not hosted
evidence, but not unverified either:

| Clause                                                | Status                                                                                                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Telemetry records arrive                              | **Unverified, hosted and locally.** No collector is configured, so there is nothing to arrive; Cloudflare's own Workers Logs and automatic traces need the dashboard to confirm                  |
| `ctx.waitUntil` flushing stays within its bound       | **Verified in workerd, not hosted.** `apps/api/src/entrypoints/worker.workers.test.ts` — "the flush goes to `ctx.waitUntil` and is not awaited: a hanging collector does not delay the response" |
| An exporter failure does not alter business responses | **Verified in workerd, not hosted.** `apps/api/src/telemetry/workers/sdk.workers.test.ts`, `describe("exporter failure")` — a refused connection, a 503, a timeout and an unreachable address    |

Hosted, the last two cannot be exercised at all while no exporter is
configured: there is no exporter to fail and no flush to time. Standing a
collector up would be new infrastructure and is outside what #33 authorizes.

## Deployment timeline

All times UTC on 2026-09-19, from `gh run list --workflow=deploy-prod.yml`
and the runs' logs.

| Time     | Run         | Trigger                    | Outcome                                                                                                                        |
| -------- | ----------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 17:39:38 | 35458517518 | push (#39)                 | Skipped                                                                                                                        |
| 17:49:27 | 35459265564 | push (#41)                 | Failed after 22 s                                                                                                              |
| 18:03:12 | 35459962227 | push (#42)                 | Failed: the billing signature; **no database created**                                                                         |
| 18:35:37 | 35460411214 | push (#43)                 | **Created the database (18:36:27Z) and both roles**; failed storing the migration credential                                   |
| 18:48:57 | 35462394784 | push (#44)                 | Failed                                                                                                                         |
| 18:50:52 | 35462498113 | dispatch, rotate=migration | Rotated `scos_migrator`; **created Hyperdrive (18:51:59Z)** and applied the migration (18:52:08Z); failed at the Worker deploy |
| 19:04:12 | 35463180610 | push (#45)                 | **First successful deploy**; subdomain already registered                                                                      |
| 19:07:56 | 35463375940 | dispatch, seed             | **Seeded the six warehouses (19:09:19Z)**                                                                                      |
| 19:34:17 | 35464751718 | push (#46)                 | **Current deployment**, version `fcd23e34-…`                                                                                   |

## Known limitations

- **Public and unauthenticated.** Anyone with the URL can submit orders and
  consume the finite stock. There is no rate limit in the application.
- **Finite, unreplenishable stock** (see
  [demonstration data](#demonstration-data)). When it runs out, every
  submission returns `INSUFFICIENT_STOCK` until the database is reseeded from
  scratch, which means deleting the data.
- **No approval on the path to production.** Every push to `main` deploys
  with no reviewer, no enable flag and no wait for CI, and `main`'s branch
  protection requires no status checks
  ([risk](deployment-pipeline.md#offline-preparation-and-hosted-execution)).
  A deploy after a teardown would recreate the database and restart billing.
- **Single node, no HA.** PS-5, 0 replicas: a cluster failure is an outage,
  and the demo is disposable by design.
- **Backups are 12-hourly and kept 2 days**
  ([backups](planetscale-bootstrap.md#backups)); up to 12 hours of demo
  Orders can be lost on a restore.
- **No telemetry backend** (see [telemetry](#telemetry) above).
- **No latency or throughput target is agreed**, so timings are reported as
  observed.
- **Submissions serialize.** Every submission locks all six warehouse rows in
  id order, so concurrent submissions queue behind each other whatever the
  cluster size
  ([connection budget](cloudflare-deployment-design.md#connection-budget)).

## What is not verified

These are gaps in this record, owned by whoever has the account credentials.

| Gap                                                                                                                                                     | Why                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Actual charges** (Cloudflare billing view, PlanetScale usage)                                                                                         | No access; see [actual charges](#actual-charges-an-open-gap)         |
| `max_connections` and PlanetScale's reserved connections, and therefore the [budget rule](cloudflare-deployment-design.md#connection-budget) arithmetic | No PlanetScale credentials; the Parameters tab could not be read     |
| Origin connection counts and queueing under load (Hyperdrive analytics)                                                                                 | The Cloudflare MCP access here is bound to a different account       |
| Workers Logs ingestion, automatic traces, CPU time per request                                                                                          | Same                                                                 |
| Whether the Hyperdrive configuration's live caching setting matches the committed one                                                                   | Inferred from Terraform reporting no drift, not read from the API    |
| Provenance of the 150 consumed units                                                                                                                    | No database access; inferred from residual stock                     |
| Whether PlanetScale backups survive `pscale database delete`                                                                                            | Undocumented; [assume they do not](planetscale-bootstrap.md#backups) |

## Teardown

**Nothing below has been performed.** Every step is destructive and needs its
own explicit authorization.

> **Do step 0 first and leave it done.** `Deploy Prod` was still `active` on
> 2026-09-20. The deploy creates a missing database, so any later push to
> `main` — including a documentation merge — would provision a new, empty
> PlanetScale database and **restart billing**, silently. Disabling the
> workflow is the only thing that prevents it.

| #   | Step                                                                                                                                               | Destroyed                                                                                                                                    | Recoverable?                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 0   | `gh workflow disable deploy-prod.yml`                                                                                                              | Nothing                                                                                                                                      | Yes: `gh workflow enable deploy-prod.yml`                                                                    |
| 1   | `wrangler delete --name scos-api`                                                                                                                  | The Worker, its version history, its `vars` and any Worker secret; the API stops serving                                                     | The Worker is redeployable from `main`, but with a new version history and a new binding                     |
| 2   | `infra/cloudflare/scripts/backend-init.sh infra/cloudflare` then `terraform -chdir=infra/cloudflare destroy`                                       | The Hyperdrive configuration (ID `78cbd0b0c…`) **and both stored role credentials**                                                          | A new apply creates a new configuration with a new ID; the passwords are gone, so both roles must be rotated |
| 3   | `pscale database delete scos --org bonanaaaaaa`                                                                                                    | **Billing stops here.** The database, its `main` branch, both roles, all Orders and submission history, all stock, and probably every backup | **No.** Irrecoverable                                                                                        |
| 4   | Delete `scos/prod/terraform.tfstate` and `scos/prod/state-backups/` in R2                                                                          | The Terraform state and its 10 backups — the last copy of any credential not already destroyed                                               | No, but by this point they refer to nothing                                                                  |
| 5   | Delete the R2 bucket `bonanaaaaaa-scos-ac4c2d32-tfstate` and its API token                                                                         | The bucket and the R2 key pair                                                                                                               | Re-creatable by hand ([one-time bootstrap](deployment-pipeline.md#the-state-bucket-one-time-bootstrap))      |
| 6   | Delete **only the deployment's** GitHub secrets and variables (named below), and revoke the PlanetScale service token and the Cloudflare API token | The pipeline's ability to provision anything                                                                                                 | Re-creatable; re-doing it is the [operator checklist](deployment-pipeline.md#operator-checklist)             |

Order matters: 1 before 2 (the Worker would otherwise point at a deleted
Hyperdrive configuration), 2 before 3 (Terraform needs no database, but
destroying it afterwards leaves the Hyperdrive origin pointing at nothing),
and 3 before 4 (the state is the only copy of the migration URL, which is how
an operator reaches the database at all).

Details worth knowing before starting:

- **Step 3 is the only step that stops the charge.** Steps 1, 2 and 4-6
  remove Cloudflare and GitHub resources and change the PlanetScale bill by
  nothing.
- **The roles go with the database.** `scos_runtime` and `scos_migrator` are
  branch-scoped and are deleted with `scos`. `pscale role reassign` is needed
  only when deleting a role while keeping the database, because
  `scos_migrator` owns every object it created
  ([roles](planetscale-bootstrap.md#roles)).
- **The PlanetScale service token is organization-scoped** and survives
  step 3. It can still create a new database, so revoke it in step 6 if the
  organization is finished with.
- **The `workers.dev` subdomain survives.** `bonanaaaaaa-scos.workers.dev` is
  an account-level name that predates this pipeline; deleting the Worker
  frees `scos-api` under it but does not remove it.
- **Operator override variables.** `PLANETSCALE_HOST`,
  `HYPERDRIVE_ORIGIN_USER` and `HYPERDRIVE_ORIGIN_DATABASE` are not set
  today, so there is nothing stale to delete; if any is added before a
  teardown, delete it too, or a later re-creation reuses a dead value
  ([teardown](planetscale-bootstrap.md#teardown)).
- **Step 6 deletes named secrets, not every secret.** The repository also
  holds `TURBO_TOKEN` and `TURBO_REMOTE_CACHE_SIGNATURE_KEY`, and the
  variables `TURBO_API` and `TURBO_TEAM`, which belong to the Turborepo
  remote cache and have nothing to do with this deployment; deleting them
  would break CI caching. Delete exactly these and nothing else:
  - repository secrets `PLANETSCALE_SERVICE_TOKEN`, `R2_ACCESS_KEY_ID`,
    `R2_SECRET_ACCESS_KEY`;
  - repository variables `PLANETSCALE_ORG`, `PLANETSCALE_SERVICE_TOKEN_ID`;
  - the `prod` environment secret `CLOUDFLARE_API_TOKEN` and the `prod`
    variables `CLOUDFLARE_ACCOUNT_ID` and `TF_STATE_*`.
- **Taking only the Worker down**, without stopping billing, is step 1 alone.
  Billing continues.

## Sources

- `Deploy Prod` runs 35459962227, 35460411214, 35462394784, 35462498113,
  35463180610, 35463375940 and 35464751718 (`gh run view <id> --log`).
- `gh secret list`, `gh secret list --env prod`, `gh variable list`,
  `gh variable list --env prod`, `gh workflow list --all`,
  `gh run list --workflow=planetscale-bootstrap.yml`,
  `gh api repos/bonanaaaaaa/scos/environments/prod`, all on 2026-09-20.
- `infra/cloudflare/main.tf`, `infra/cloudflare/variables.tf`,
  `apps/api/wrangler.jsonc`, `packages/persistence/src/seed.ts`,
  `.github/workflows/deploy.yml`, `.github/workflows/deploy-prod.yml`.
- Live `curl` against `https://scos-api.bonanaaaaaa-scos.workers.dev` on
  2026-09-20.
