# Deployment pipeline: Terraform, R2 state and the Worker deploy

This is #15's pipeline for the Cloudflare side: Terraform for the Hyperdrive
configuration, its state in R2, and the GitHub Actions workflows that check
pull requests and deploy `main`. The PlanetScale database, its roles and the
seed are in [PlanetScale bootstrap](planetscale-bootstrap.md). The design
inputs are in [Cloudflare deployment design](cloudflare-deployment-design.md)
and [ADR 0005](adr/0005-cloudflare-first-deployment.md).

## Offline preparation and hosted execution

Everything in this repository is **offline preparation**. Merging it
provisions nothing and deploys nothing:

- `infra-check.yml` runs on pull requests with no secret and no environment.
- `Deploy Prod` (`deploy-prod.yml`) runs on every merge to `main`, but no job
  runs until the repository variable `DEPLOY_ENABLED` is `true`. It is not
  set, so nothing starts in the `prod` environment and nothing asks for
  approval.

**Hosted execution** waits on the user's account, budget and provisioning
authorization. That covers every step that touches Cloudflare or PlanetScale:
the PlanetScale database and roles (created by the first approved deploy,
which starts billing), the first Terraform apply, migrations and the Worker
deploy. #33 runs and verifies it.

**The deploy creates the database.** By the user's decision
([ADR 0005 amendment](adr/0005-cloudflare-first-deployment.md)), the deploy
job runs the PlanetScale bootstrap first and creates the database and its
roles when they are missing. This relaxes two #15 criteria: the PlanetScale
service token is used by the deploy, not only by the bootstrap workflow, and
a merge to `main` (through the approved deploy) can create the database.
Setting `DEPLOY_ENABLED=true` and approving the first deploy is therefore the
provisioning authorization.

### Operator checklist

In this order. Nothing here is automated.

1. **Protect `prod`.** Add a required reviewer to the `prod` environment
   (Settings > Environments > prod), and consider turning off administrator
   bypass. Every job that uses a `prod` secret waits for that approval.
   Also restrict the `prod` environment's deployment branches to `main`
   (Deployment branches and tags > Selected branches), so no other branch's
   workflow can use its secrets.
2. **Check the R2 state bucket** is private (see
   [the bucket](#the-state-bucket-one-time-bootstrap)).
3. **Prepare PlanetScale** (no bootstrap run is needed; the first deploy
   creates the database and roles): set the repository variable
   `PLANETSCALE_ORG`, give the service token its accesses, confirm the
   cluster size SKU, and create the `prod` secret `ENVIRONMENT_SECRETS_TOKEN`,
   which the deploy requires
   ([PlanetScale bootstrap](planetscale-bootstrap.md#before-the-first-run)).
4. **Create the Cloudflare API tokens** (Terraform, Workers, and the billing
   signature `CLOUDFLARE_API_TOKEN`) and set the `prod` secrets and variables
   in [Credentials](#credentials) and [Configuration](#configuration-contract).
   Do not set `PLANETSCALE_HOST`, `HYPERDRIVE_ORIGIN_USER`,
   `HYPERDRIVE_ORIGIN_DATABASE`, `HYPERDRIVE_ORIGIN_PASSWORD` or
   `MIGRATION_DATABASE_URL`: the first deploy's bootstrap step writes them.
5. **Set the repository variable `DEPLOY_ENABLED=true`**. The next merge to `main`
   (or a manual run of `Deploy Prod` on `main`) deploys, and its approval
   starts PlanetScale billing when the database does not exist yet.
6. **Seed once**, after the first deployment applied the migrations
   ([seeding](planetscale-bootstrap.md#seeding-demonstration-data)).

## Resources and owners

| Owner                                                          | Resources                                                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `infra/planetscale/` (deploy step; manual workflow for repair) | The PlanetScale database, branch settings, runtime and migration roles                      |
| Terraform, `infra/cloudflare/`                                 | `cloudflare_hyperdrive_config.scos` (named `scos-prod`); DNS only if a custom host is added |
| Wrangler, `apps/api/wrangler.jsonc`                            | The `scos-api` Worker, its versions, vars, secrets and the `HYPERDRIVE` binding             |
| Created once by hand, outside Terraform                        | The R2 state bucket and its key pair                                                        |

## Terraform

`infra/cloudflare/`:

| File                          | Contents                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| `versions.tf`                 | Terraform `>= 1.11, < 2` (CI pins 1.16.3), `cloudflare/cloudflare` 5.25.0, the `s3` backend |
| `main.tf`                     | The Hyperdrive configuration                                                                |
| `variables.tf`, `outputs.tf`  | Inputs; the one output, `hyperdrive_id`                                                     |
| `.terraform.lock.hcl`         | Provider hashes for linux_amd64, linux_arm64, darwin_arm64 and darwin_amd64                 |
| `tests/hyperdrive.tftest.hcl` | `terraform test` with a mocked provider: caching, connection limit, origin, validations     |
| `scripts/`                    | Backend init, state backup, main-head check, Worker bundle and deploy configuration         |

The Hyperdrive configuration follows #28:

- **Origin** from non-secret inputs: `PLANETSCALE_HOST`, port 5432, scheme
  `postgres`, the database `HYPERDRIVE_ORIGIN_DATABASE` (default `postgres`,
  the PostgreSQL name PlanetScale reports, not the PlanetScale database
  name) and the username `HYPERDRIVE_ORIGIN_USER` (exactly as PlanetScale
  reports it). The password is the `sensitive` variable
  `hyperdrive_origin_password`.
- **Caching** `caching = { disabled = true }`, set explicitly.
- **`origin_connection_limit = 5`**, validated to 5-20. Raise it only within
  the [budget rule](cloudflare-deployment-design.md#connection-budget).
- **TLS**: Hyperdrive's default `sslmode=require`. `verify-full` is optional
  hardening and not set.

To change the provider version, edit `versions.tf` and regenerate the lock
file for all four platforms:

```sh
cd infra/cloudflare
terraform providers lock -platform=linux_amd64 -platform=linux_arm64 \
  -platform=darwin_arm64 -platform=darwin_amd64
```

### One Wrangler

The pipeline and its scripts (the dry-run build and the deploy) use the one
Wrangler pinned in the workspace: `apps/api`'s `devDependencies`, run as
`apps/api/node_modules/.bin/wrangler` after `pnpm install --frozen-lockfile`.
Nothing uses `npx` or a global install, so a Wrangler upgrade is one change to
`apps/api/package.json` and the lockfile. The `wrangler ...` commands an
operator runs in this document (rollback, secrets, teardown, R2 checks) mean
the same binary: `pnpm --filter @scos/api exec wrangler ...`.

### Hyperdrive ID injection

The pipeline injects the ID from the Terraform output; nothing is committed.
`apps/api/wrangler.jsonc` keeps its placeholder ID and `localConnectionString`,
so `wrangler dev` and the Workers tests are unchanged.

`scripts/worker-deploy-config.mjs` reads `wrangler.jsonc` and writes a
separate deploy configuration on the runner. It:

- requires exactly one `HYPERDRIVE` binding with the placeholder, and a
  32-hex ID that is not the placeholder;
- sets that ID and drops `localConnectionString`;
- points `main` at the built bundle with `no_bundle`, so Wrangler uploads the
  files as built;
- sets the non-secret `vars` from the environment (allow-list) and the
  placement hint;
- validates the result with the Worker's own `parseWorkerConfig`, including
  `OTEL_EXPORTER_OTLP_HEADERS` from the secret, and fails with
  `NAME: reason` lines and no values.

The generated file is not uploaded and is deleted with the job. A
committed ID would work too (the ID is not a secret), but it would couple the
repository to one account and go stale on a `terraform destroy`.

### Placement hint

The deploy configuration sets `"placement": { "region": "aws:ap-southeast-1" }`,
beside the database in Singapore. A submission makes several round trips to
the database, so running the Worker there shortens each one. It is only in
the generated configuration, so local development never sees it. Set the
`prod` variable `WORKER_PLACEMENT_REGION` to `none` to drop it, or to another
region. Whether the hint needs a paid plan is unverified; if the first deploy
rejects it, set `none`.

## Terraform state

### Backend

State is in the private R2 bucket, split by environment through the key:
`TF_STATE_KEY` is `scos/<env>/terraform.tfstate`. The `s3` backend block
holds the fixed R2 settings: `use_path_style`, `use_lockfile = true`, and the
`skip_credentials_validation`, `skip_region_validation`,
`skip_requesting_account_id`, `skip_metadata_api_check` and
`skip_s3_checksum` flags. `scripts/backend-init.sh` supplies the rest from the
environment's variables (`TF_STATE_BUCKET`, `TF_STATE_ENDPOINT`
`https://<account_id>.r2.cloudflarestorage.com`, `TF_STATE_REGION` `auto`,
`TF_STATE_KEY`, `TF_STATE_WORKSPACE_PREFIX`). Terraform reads the R2 key pair
from `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, mapped from the
repository secrets `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` in the deploy
job only. Only the default workspace is used.

To work on the state locally (for example a restore), export the same
variables and the R2 key pair, then:

```sh
infra/cloudflare/scripts/backend-init.sh infra/cloudflare
```

### Locking

Locking relies on the s3 backend's own lock file: `use_lockfile = true`
writes `<key>.tflock` with a conditional put (`If-None-Match`), which R2's S3
API lists as supported, so a second run against the same key fails with
`Error acquiring the state lock` instead of writing concurrently.

- **Shown locally, not on R2.** During development (2026-09-19) a second
  Terraform run against the same key was rejected with
  `StatusCode: 412 ... PreconditionFailed` while the first held the lock,
  against MinIO `RELEASE.2025-09-07T16-13-09Z` with Terraform 1.11.2 and
  1.16.3, and the lock was released afterwards. It was not proven against
  R2: by the user's decision, the issue's "prove on R2" criterion is dropped.
  That locking behaves the same on R2 is a known, accepted risk.
- **The workflows serialize themselves.** The caller's `deploy-prod`
  concurrency group runs one deployment at a time and never cancels a
  running one, so the pipeline never races itself; the lock file guards
  against anything else (an operator's local run, another workflow).
- Every plan and apply waits up to 5 minutes for the lock
  (`-lock-timeout=5m`), then fails. Never pass `-lock=false`.

### The state is a secret

The state holds the Hyperdrive origin password.

- `*.tfstate*`, `*.tfplan` and `.terraform/` are ignored by Git.
- The one output, `hyperdrive_id`, is `sensitive`; the workflow reads it with
  `terraform output -raw` and masks it.
- **The saved plan never leaves the job.** Plan and apply run in the same job
  on the same runner, so no artifact is needed. The plan file holds the
  password in clear text; it is written with `umask 077` and deleted at the
  end of the job, whatever the outcome. The plan is never printed: the log
  and the job summary show only `actions address` lines from
  `terraform show -json`. No plan or state reaches a pull request comment.
- Apply output shows progress lines only. Sensitive values are redacted by
  Terraform; the Hyperdrive ID may appear before it is masked, which is
  acceptable: it is not a credential.

### Backups and recovery

R2 does not implement object versioning (`PutBucketVersioning` is listed as
unsupported in R2's S3 compatibility table, checked 2026-09-19). So the
deploy takes a bounded backup before every plan:
`scripts/state-backup.sh backup <commit>-run<id>` copies the state object,
server-side, to `scos/<env>/state-backups/terraform.tfstate.<UTC time>.<label>`
in the same bucket and keeps the newest 10 (`STATE_BACKUP_KEEP`). The first
apply has no state and skips the backup. R2 tokens are scoped to a bucket, not
a prefix, so the backups are exactly as private as the state.

To restore, with no deploy running:

```sh
# The same TF_STATE_* variables and R2 key pair as backend-init.sh.
infra/cloudflare/scripts/state-backup.sh list
infra/cloudflare/scripts/state-backup.sh restore scos/prod/state-backups/terraform.tfstate.<time>.<label>
infra/cloudflare/scripts/backend-init.sh infra/cloudflare
terraform -chdir=infra/cloudflare plan   # with the TF_VAR_* inputs
```

`restore` refuses while `<key>.tflock` exists. If the backup predates a
change, the plan shows it; apply to bring Cloudflare back in line, or
`terraform import cloudflare_hyperdrive_config.scos '<account_id>/<hyperdrive_id>'`
if the state lost the resource.

### The state bucket (one-time bootstrap)

The bucket and its key pair were created once, by hand, outside Terraform, so
Terraform never manages its own backend. To repeat it:

1. Create the bucket: dashboard R2 > Create bucket, or
   `wrangler r2 bucket create <bucket>` with an account login. Put its name in
   each environment's `TF_STATE_BUCKET`.
2. Keep it private: public access off, no r2.dev URL
   (`wrangler r2 bucket dev-url get <bucket>` reports it disabled), and no
   custom domain (`wrangler r2 bucket domain list <bucket>` is empty).
3. Create an R2 API token (R2 > Manage API tokens) with **Object Read &
   Write** on this bucket only. Store its access key ID and secret as the
   repository secrets `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`.
4. Set `TF_STATE_ENDPOINT` to `https://<account_id>.r2.cloudflarestorage.com`
   and `TF_STATE_REGION` to `auto` on each environment.

R2 tokens scope to a bucket. If a second stack (for example the deferred AWS
track) needs state, give it its own prefix, and revisit sharing the bucket.

## Credentials

Cloudflare has no GitHub OIDC federation for API tokens (checked
2026-09-19: no documented feature; an open feature request exists). This
pipeline uses **scoped, long-lived tokens**, the downgrade ADR 0005 accepts.
Give each token an expiry and rotate it.

| Credential                                                              | Kind                                    | Scope                                                                                             | Used by                                                                                                                |
| ----------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`                              | Repository secrets                      | R2 Object Read & Write on the state bucket                                                        | Passed by `deploy-prod.yml` to `deploy.yml` only (the bootstrap does not need them)                                    |
| `PLANETSCALE_SERVICE_TOKEN` (+ variable `PLANETSCALE_SERVICE_TOKEN_ID`) | Repository secret                       | Create the database, manage its roles ([accesses](planetscale-bootstrap.md#before-the-first-run)) | Passed by `deploy-prod.yml` to `deploy.yml` (`planetscale_service_token`), bootstrap step; `planetscale-bootstrap.yml` |
| `CLOUDFLARE_API_TOKEN`                                                  | `prod` secret                           | The billing signature for the database                                                            | `deploy.yml` bootstrap step (used only while the database is missing); `planetscale-bootstrap.yml`                     |
| `ENVIRONMENT_SECRETS_TOKEN` (required)                                  | `prod` secret                           | Fine-grained token: this repository's Environments, read and write (secrets and variables)        | `deploy.yml` bootstrap step; `planetscale-bootstrap.yml`                                                               |
| `CLOUDFLARE_TERRAFORM_API_TOKEN`                                        | `prod` secret                           | Account: Hyperdrive Edit (add Zone: DNS Edit on one zone only if a custom host is added)          | `deploy.yml` (read in its `prod` jobs), Terraform steps                                                                |
| `CLOUDFLARE_WORKERS_API_TOKEN`                                          | `prod` secret                           | Account: Workers Scripts Edit (the "Edit Cloudflare Workers" template, trimmed to this account)   | `deploy.yml`, Wrangler step                                                                                            |
| `HYPERDRIVE_ORIGIN_PASSWORD`                                            | `prod` secret, written by the bootstrap | The runtime role's password; becomes `TF_VAR_hyperdrive_origin_password`                          | `deploy.yml`, Terraform plan                                                                                           |
| `MIGRATION_DATABASE_URL`                                                | `prod` secret, written by the bootstrap | The migration role, direct to the branch host on 5432, `sslmode=require`                          | `deploy.yml` migrations; `seed-demo-data.yml`                                                                          |
| `OTEL_EXPORTER_OTLP_HEADERS` (optional)                                 | `prod` secret                           | Collector credentials, uploaded as a Worker secret                                                | `deploy.yml`, Wrangler step                                                                                            |

- Each stored secret is mapped into the environment of the steps that need it,
  never the whole job. Terraform sees only `CLOUDFLARE_TERRAFORM_API_TOKEN` (as
  `CLOUDFLARE_API_TOKEN`) of the Cloudflare tokens; Wrangler only
  `CLOUDFLARE_WORKERS_API_TOKEN`. The exception is the first deploy: role
  credentials created in that run go through `$GITHUB_ENV`, so every later
  step sees them, masked, until they are blanked after their last use (the
  origin password after the Terraform plan, the migration URL after the
  migrations, which also puts it in the Terraform apply steps' environment).
- `infra-check.yml` references no secret and no environment, and pull
  requests from forks never reach the deploy workflows: `Deploy Prod` runs on
  a **push** to `main` in this repository (or a manual run on `main`), and
  `deploy.yml` only as its callee. The caller passes only repository secrets:
  the R2 key pair (`r2_access_key_id`, `r2_secret_access_key`) and the
  PlanetScale service token (`planetscale_service_token`); the `prod` secrets
  are read by the shared workflow's `prod`-bound jobs, never passed. The Worker never sees a PlanetScale credential; it only has the
  Hyperdrive binding.
- The deploy job does not use the Turbo remote cache, so the uploaded bundle
  is always built from source, from the commit CI tested. It is not CI's
  artifact: CI builds and tests the same commit separately.

**One-time order**, with no circular dependency: R2 bucket and key pair (by
hand) → Cloudflare tokens, `ENVIRONMENT_SECRETS_TOKEN` and `prod` variables →
`DEPLOY_ENABLED=true` → first deploy (the bootstrap step creates the
database, roles, role secrets and connection variables; then Terraform
creates Hyperdrive, migrations run, the Worker deploys) → seed. The manual
`planetscale-bootstrap.yml` can still create the database first, for example
as a dry run, but is not required.

**Rotation.** Role passwords: follow
[PlanetScale rotation](planetscale-bootstrap.md#rotation). For the runtime
role, the hook is to re-apply Terraform after updating
`HYPERDRIVE_ORIGIN_PASSWORD`: run `Deploy Prod` on `main` (manual run). The new
password changes the planned origin, so the plan updates Hyperdrive in place;
the Worker keeps the same ID. Cloudflare tokens: create the new token, update
the secret, delete the old token.

## Pipeline

### Pull requests: `infra-check.yml`

| Job                                    | Checks                                                                                                                                                                                                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Terraform                              | `terraform fmt -check -recursive infra`; `init -backend=false -lockfile=readonly` and `validate`; `terraform test`; an explicit "Terraform plan skipped: no trusted credentials in PR runs" notice                                                          |
| State backup (local S3)                | The backup/prune/restore script against MinIO in the job                                                                                                                                                                                                    |
| Shell scripts                          | ShellCheck 0.11.0 (pinned image) on every `infra/**/*.sh` and the PlanetScale test stubs; the PlanetScale bootstrap tests                                                                                                                                   |
| Worker bundle and deploy configuration | The deploy's own scripts with a fake Hyperdrive ID: build once, size budget (8 MiB, 3 MiB gzip, as `worker.bundle.test.ts`), checksums, generated config validated by the Worker schema, and a `--no-bundle` dry run whose modules must match the checksums |

Actionlint (`actionlint.yml`, configured by `.github/actionlint.yaml`) checks the workflows on any change under
`.github/workflows/`.

### Deploy workflows: a shared workflow and one caller per environment

| Workflow                          | Role                                                                                                                                                                                                                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy.yml` ("Deploy (shared)")  | Reusable (`on: workflow_call` only). Inputs `environment`, `sha`, `terraform_working_dir` (default `infra/cloudflare`); secrets `r2_access_key_id`, `r2_secret_access_key`, `planetscale_service_token`. One job, `deploy`, bound to `environment: ${{ inputs.environment }}` |
| `deploy-prod.yml` ("Deploy Prod") | Thin caller for `prod`: triggers, the `deploy-prod` concurrency group, the gate, and one call with `environment: prod`                                                                                                                                                        |

The environment's required reviewers pause the shared workflow's
environment-bound jobs. A caller passes only repository secrets: GitHub does
not let a caller pass environment secrets, and a job with `environment:` reads
that environment's secrets and variables itself. actionlint only knows the
declared `workflow_call` secrets, so `.github/actionlint.yaml` ignores exactly
those seven environment secret names in `deploy.yml`.

![The deployment pipeline after a merge to main](images/deployment-pipeline.svg)

**Primary trigger: a merge to `main`** (`on: push: branches: [main]`).
Secondary: a manual run (`workflow_dispatch`, on `main` only) redeploys
`main`'s head, gated exactly like a push (for example after rotating the
origin password).

1. **Gate** (`deploy-prod.yml`; no environment, no secret, `actions: read`).
   Runs only when `DEPLOY_ENABLED` is `true` and the ref is `main`. It waits
   for CI on the same commit: it polls the `CI` (`ci.yml`) push runs on
   `main` for `head_sha == github.sha` every 25 s. Success continues; a run
   that ends in failure or cancellation, no run within 5 minutes, or no
   result within 30 minutes fails the gate, and nothing deploys. On every
   poll and once more after CI passed it checks that `main` is still at this
   commit, and skips with a notice when it has moved on.
2. **Deploy** (`deploy.yml`'s `deploy` job, `environment: prod`, waits for
   the required reviewer), checking out exactly the gated commit:
   1. `main` must still be at that commit (checked again, below), and every
      required variable and secret must be set; otherwise nothing runs.
   2. Build the Worker bundle once, in this job, from the commit CI tested
      (`wrangler deploy --dry-run --outdir`; CI's own build is not reused),
      check the size budget, and record the SHA-256 of `worker.js` and the
      `.wasm` module in the job summary. Every install (pnpm, pscale with a
      pinned checksum, Terraform) runs before any step holds a secret.
   3. **Ensure the PlanetScale database:** check `main` again, then run
      `infra/planetscale/bootstrap.sh` with creation enabled. It creates the
      database (with the Cloudflare billing signature), the runtime role and
      the migration role only when missing, and never resets anything. A new
      role's credential is stored as a `prod` secret and, in this run only,
      exported masked to `$GITHUB_ENV`; the connection variables are set when
      absent ([same-run values](planetscale-bootstrap.md#same-run-values-in-the-deploy)).
      A check then fails the deploy if the host, username, origin password or
      migration URL is still missing.
   4. **Terraform:** state backup (every apply), `terraform plan -out`, then
      `terraform apply` of exactly that saved plan (after checking `main`
      again), then read `hyperdrive_id`.
   5. **Migrations:** `prisma migrate deploy` with `MIGRATION_DATABASE_URL`,
      after checking it points at `PLANETSCALE_HOST` on 5432 with
      `sslmode=require` or stricter: directly to PlanetScale, never through
      Hyperdrive.
   6. **Worker:** generate the deploy configuration (with
      `DEPLOYMENT_ENVIRONMENT` set to the environment name), check `main`
      again, re-verify the checksums, and `wrangler deploy` the built files
      (`no_bundle`), with `OTEL_EXPORTER_OTLP_HEADERS` uploaded as a Worker
      secret (`--secrets-file`, a private file removed at once). The dry run
      of this configuration uploads byte-identical modules (checked in CI).
   7. **Health check:** `GET /health` must return `{"status":"ok"}` within 12
      tries, 10 s apart.
   8. Delete the plan and generated files, always.

Any failing step fails the run, and later steps do not run: a failed
migration never deploys the Worker. Nothing is destroyed automatically, on
merge or on failure.

- **Why the gate waits for CI.** #15 requires deploying only after CI passed
  on `main` for the same commit. A merge is the trigger, so the deploy starts
  on the push and waits for the CI run that the same push started. The
  alternatives were rejected: `workflow_run` makes the CI completion, not the
  merge, the trigger (and runs from a separate event); calling CI through
  `workflow_call` would run CI a second time for every merge. `ci.yml`'s
  triggers are unchanged.
- **Never an older commit over a newer one.** The gate skips a commit that
  is no longer the head of `main`. `CI` cancels an older run on `main` when a
  newer push arrives; the gate then sees `main` moved on and skips instead of
  failing. The deploy job checks again as its first step, before
  `terraform apply` and before `wrangler deploy`, because "Re-run failed
  jobs" reruns only the deploy job with the gate's old commit, and a pending
  approval can wait while `main` moves on. When `main` has moved, the step
  fails with "Stale deploy stopped"; the newer commit's own run deploys it. A
  stop before `terraform apply` changes nothing; a stop before
  `wrangler deploy` can leave Hyperdrive and migrations from the older commit
  in place, which the newer commit's deploy then brings forward. If the
  newer commit's CI fails, the previous Worker keeps serving with those
  (backward-compatible) migrations until a green push, or a manual
  `Deploy Prod` run on `main` once CI is green.
- **Serialization.** Caller concurrency group `deploy-prod`,
  `cancel-in-progress: false`, which also holds a gate waiting for CI. A newer push replaces a pending run, which shows as
  cancelled; the newer commit deploys instead. The shared `deploy` job also
  joins `seed-demo-data-<environment>` (`seed-demo-data-prod`), the seed
  workflow's group, so a seed never runs during a deploy. GitHub keeps at
  most one running and one pending run per group, and that holds across
  workflows: a deploy job and a seed run both queue in
  `seed-demo-data-prod`. A newer pending entry replaces the older one, which
  shows as cancelled. So a seed waiting behind a running deploy is cancelled
  if another deploy queues after it, and a pending deploy is cancelled if a
  seed is started behind it. The seed workflow refuses to start while a
  `Deploy Prod` run is active
  ([seeding](planetscale-bootstrap.md#seeding-demonstration-data)); rerun
  whichever was cancelled once the group is idle.

### Adding another environment

1. Create the GitHub environment (for example `staging`) with its own
   required reviewers, deployment branch rule, variables (`TF_STATE_*` with
   its own key, `scos/staging/terraform.tfstate`, and workspace prefix;
   `CLOUDFLARE_ACCOUNT_ID`, `PLANETSCALE_DATABASE`, ...) and secrets
   (Cloudflare tokens, `ENVIRONMENT_SECRETS_TOKEN`). Its own PlanetScale
   database, roles, role secrets and connection variables come from the
   deploy's bootstrap step; give it its own `PLANETSCALE_DATABASE`.
2. Add a thin caller, `deploy-staging.yml`, modelled on `deploy-prod.yml`:
   its own trigger and gate, its own concurrency group (`deploy-staging`),
   and `uses: ./.github/workflows/deploy.yml` with `environment: staging`,
   passing the R2 key pair and the PlanetScale service token. Note that the shared job's main-head checks
   deploy only `main`'s head; an environment fed from another branch needs
   that check parameterized first.
3. Add the caller to the seed workflow's active-deploy check, and give the
   seed a matching `seed-demo-data-staging` group if that environment is
   seeded.

- **Stale plans.** Terraform refuses a saved plan when the state changed after
  it was made, and the step fails. Rerun the failed job: it replans, and the
  environment's approval is asked again.
- **What the health check proves.** A Worker with invalid configuration
  answers `500` to every request, `/health` included
  (`src/entrypoints/worker.workers.test.ts`, "invalid: nothing is served").
  So a healthy `/health` proves the configuration validated. It does not
  prove database connectivity, which is a separate check; #33 verifies the
  ordering endpoints through Hyperdrive.
- **Worker URL.** The health check uses the `prod` variable `WORKER_BASE_URL`
  if set, otherwise the `workers.dev` URL Wrangler prints.

## Configuration contract

The Worker validates its configuration once per isolate with
`parseWorkerConfig` (`apps/api/src/config.ts`, the schema in
`apps/api/src/telemetry/config.ts`); see
[observability](observability.md#configuration-1). `DATABASE_URL` is always
the `HYPERDRIVE` binding's connection string, never a variable. The deploy
sets:

| Worker setting                                                                                                                           | Source                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                                                                           | The `HYPERDRIVE` binding (ID from Terraform)                                                              |
| `DEPLOYMENT_ENVIRONMENT`                                                                                                                 | The caller's `environment` input (`prod`)                                                                 |
| `SERVICE_VERSION`                                                                                                                        | The deployed commit SHA                                                                                   |
| `OTEL_SERVICE_NAME`                                                                                                                      | `scos-api` from `wrangler.jsonc`                                                                          |
| `LOG_LEVEL`, `OTEL_SDK_DISABLED`, `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER`, `OTEL_TRACES_SAMPLER_ARG`                             | `prod` variables of the same names; unset keeps `wrangler.jsonc` or the schema default (exporters `none`) |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, `OTEL_EXPORTER_OTLP_TIMEOUT` | `prod` variables of the same names                                                                        |
| `OTEL_EXPORTER_OTLP_HEADERS`                                                                                                             | `prod` secret, uploaded as a Worker secret, never a var                                                   |

Other `prod` variables the pipeline reads: `CLOUDFLARE_ACCOUNT_ID`,
`TF_STATE_*`, the PlanetScale inputs (`PLANETSCALE_DATABASE`, `_BRANCH`,
`_REGION`, `_CLUSTER_SIZE`, `MIGRATION_ROLE_NAME`, all with defaults), and the
optional `WORKER_BASE_URL` and `WORKER_PLACEMENT_REGION`. `PLANETSCALE_HOST`,
`HYPERDRIVE_ORIGIN_USER` and `HYPERDRIVE_ORIGIN_DATABASE` (default `postgres`)
are written by the bootstrap step when unset; the same run's values take
precedence. `DEPLOY_ENABLED`, `PLANETSCALE_ORG` and
`PLANETSCALE_SERVICE_TOKEN_ID` are repository variables.

- An invalid value fails the deploy before upload (the generator runs the
  same schema) and, if one got through, the Worker would serve nothing.
  Configuration validation is not a connectivity check: a reachable
  Hyperdrive is only exercised by requests that use the database.
- `vars` are replaced on each deploy (no `--keep-vars`). Secrets persist
  across deploys; to remove the collector headers, run
  `wrangler secret delete OTEL_EXPORTER_OTLP_HEADERS --name scos-api`.
- Exporter failures never change a response: see
  [export failure behaviour](observability.md#flush-limits-and-subrequests)
  and the tests `src/entrypoints/worker.workers.test.ts` ("a hanging
  collector does not delay the response"), `src/telemetry/workers/sdk.workers.test.ts`
  ("an unreachable collector on the real fetch") and
  `test/workers/worker.workers.integration.test.ts` ("an unreachable
  collector changes no response and holds no lock").

## Rollback and recovery

These are separate.

- **Worker rollback** (code or configuration): `wrangler rollback
<version-id> --name scos-api -m "<reason>"` with the Workers token, or the
  dashboard's Deployments tab. List versions with
  `wrangler deployments list --name scos-api`. It does not touch the database
  or Hyperdrive, and the next deploy from `main` replaces it, so revert the
  commit too.
- **Database recovery:** restore a PlanetScale backup
  ([backups](planetscale-bootstrap.md#backups)). Migrations are forward-only:
  a rolled-back Worker must still work with the newer schema, or the database
  must be restored with it. A restore loses Orders taken since the backup.
- **Hyperdrive or state:** re-apply from `main`, or restore the state
  ([above](#backups-and-recovery)).

## Teardown

Explicit, ordered and never automated. Each step loses data:

1. `wrangler delete --name scos-api` (Workers token): the API stops serving.
   Its versions and Worker secrets are gone.
2. `terraform -chdir=infra/cloudflare destroy` (after `backend-init.sh`, with
   the same `TF_VAR_*` inputs): the Hyperdrive configuration is gone. The
   state object and its backups stay in R2; delete them by hand if the stack
   is gone for good.
3. `pscale database delete <db> --org <org>`: **this is what stops
   PlanetScale billing.** All Orders, stock and, probably, its backups are
   lost for good ([teardown](planetscale-bootstrap.md#teardown)).

Set the repository variable `DEPLOY_ENABLED` to anything but `true` first.
This matters more now: the deploy creates a missing database, so a merge after
step 3 would provision a new, empty database and start billing again.

## Verification (offline, 2026-09-19)

- `terraform fmt -check -recursive`, `init -backend=false -lockfile=readonly`,
  `validate` and `terraform test` (4 passed) with Terraform 1.16.3; a mutation
  to `disabled = false` fails the test.
- A concurrent Terraform run against MinIO was rejected by the lock file
  (Terraform 1.11.2 and 1.16.3); not repeated in CI and not proven on R2
  ([Locking](#locking)).
- Backup, pruning to N, restore, refusal while locked, and failure on bad
  credentials or a failed listing (missing bucket), against MinIO.
- The bundle built twice gave identical checksums, and the `--no-bundle` dry
  run of the generated configuration (fake Hyperdrive ID) uploaded
  byte-identical modules: 5,515.37 KiB, 1,538.44 KiB gzip.
- ShellCheck 0.11.0 and actionlint 1.7.12 clean.

Unverified until #33: everything against R2, Cloudflare and PlanetScale, the
token scopes, the placement hint on the chosen plan, and the Wrangler output
lines the job summary parses.
