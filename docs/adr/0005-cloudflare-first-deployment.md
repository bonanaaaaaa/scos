# Deploy to Cloudflare Workers and PlanetScale Postgres first; AWS Lambda later

The original plan hosted the demonstration on AWS: one Lambda function per endpoint, reaching Amazon RDS or Aurora PostgreSQL through RDS Proxy. On 2026-09-19 an AWS account issue blocked that track before the submission deadline. The hosted demonstration now ships first on Cloudflare Workers, with the data in PlanetScale Postgres and the Worker reaching it through Cloudflare Hyperdrive. The AWS Lambda deployment is deferred, not dropped: its design stays in the documentation and resumes after the Cloudflare demonstration (#14, #16, draft PR #31).

Neither target touches the domain. Both are driving adapters over the same Hono composition, which is why the switch is a change of entry point and infrastructure only.

Decisions for the Cloudflare target:

- **One Worker serves all routes.** The per-endpoint composition roots stay, because the Lambda target still needs them, but Workers gains nothing from splitting: there is no per-function cold start or connection pool to isolate.
- **The database client is created per request, inside the handler.** Workers does not allow I/O objects to be reused across requests, so a client held in global scope fails. Hyperdrive keeps per-request connection setup cheap. This is the opposite of the Lambda guidance, where one pooled connection is reused across warm invocations.
- **Hyperdrive pools in transaction mode.** The submission transaction's row locks work unchanged. Lock and statement timeouts are set inside each transaction, because Hyperdrive resets a connection when it returns to the pool. Nothing may rely on session state or session-level advisory locks.
- **Hyperdrive query caching is disabled.** Hyperdrive does not invalidate cached reads when the application writes, so a cached inventory read could return stale stock.
- **Each resource has one owner.** A `pscale` CLI bootstrap script creates the PlanetScale database (billed through the Cloudflare account) and its runtime and migration roles. It runs as the first step of the deploy job and creates only what is missing; the manually triggered bootstrap workflow stays for rotation and repair. It authenticates with a PlanetScale service token (the token ID as a GitHub variable, the token as a GitHub secret). Terraform manages the Cloudflare side (the Hyperdrive configuration and any DNS), with state in a private R2 bucket. Wrangler deploys the Worker.
- **Migrations connect directly to PlanetScale** with the migration role, not through Hyperdrive.

Consequences:

- Creating the database starts daily billing. Every merge to `main` deploys, with no approval and no enable flag, so completing the deploy settings is the provisioning authorization: the first merge after that creates the database if it does not exist. The kill switch is disabling the `Deploy Prod` workflow. Later deploys find it and create nothing. Nothing ever deletes the database automatically; deletion is a manual `pscale database delete`.
- The pipeline holds a PlanetScale service token and scoped Cloudflare tokens as GitHub secrets, each limited to what its job needs. Unless GitHub OIDC federation turns out to be available, that is a downgrade from the AWS design's short-lived credentials, and it is accepted.
- The Terraform state holds the runtime role's password (Hyperdrive's origin credential), so the state bucket is treated as a secret.
- Telemetry needs its own Workers composition, because the Node SDK setup and `PinoInstrumentation` do not run in a bundled Worker. #17 delivered it (`apps/api/src/telemetry/workers/`), exporting per request under `ctx.waitUntil`.
- #15 now delivers the Cloudflare pipeline. When the AWS track resumes it needs a pipeline issue of its own (`infra/aws/`, GitHub OIDC, Lambda) between #14 and #16.
- Work is tracked in #28 (Worker runtime and Hyperdrive design), #15 (bootstrap, Terraform, and pipeline), and #33 (hosted demonstration). #28's design record is [docs/cloudflare-deployment-design.md](../cloudflare-deployment-design.md).

## Amendment (2026-09-19): the deploy creates the database

The first version of this record kept database creation out of every push- or merge-triggered workflow: a person ran a separate, approval-gated bootstrap workflow, and the deploy assumed the database existed. During #15 the user chose to fold creation into the deployment, so a merge to `main` provisions everything a deploy needs in one run.

- The bootstrap stays idempotent: it creates the database and its roles only when they are missing, and never recreates, resizes or resets them.
- The deploy workflow now holds the PlanetScale service token and the Cloudflare billing-signature token, which were limited to the bootstrap workflow.
- A role's password is shown only when the role is created, so the deploy stores both role credentials in the Terraform state in the same run, by the user's choice, instead of GitHub secrets. The state was already a secret (it held the runtime password for Hyperdrive), lives in the private R2 bucket and is backed up before every apply, so that backup is now also the credential backup. Losing the state means restoring a backup or resetting both roles. Rotation is one manual `Deploy Prod` run with `rotate_credentials`, which resets the role and replaces the stored value; a reset done outside the deploy would leave a dead password in the state. The connection details (branch host, runtime username, database name) are not secret and are read from PlanetScale on every deploy, so the deploy writes no GitHub secret or variable.
- The `prod` environment has no required reviewers, by the user's choice: every merge to `main` deploys to production without a person approving it.
- The deploy does not wait for CI on the merge commit, and there is no enable flag, both by the user's choice: the pull request's CI vouches for the change, and disabling the `Deploy Prod` workflow is the kill switch. Safety therefore rests on pull-request CI and the workflows' main-only checks. `main`'s branch protection does not yet require status checks or pull requests, and `prod` has no deployment-branch rule, so a failing pull request or a direct push would still deploy until those rules are added.
- Deleting the database, which stops billing, stays manual.
