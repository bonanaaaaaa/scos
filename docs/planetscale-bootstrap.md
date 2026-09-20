# PlanetScale bootstrap

This is the runbook for the PlanetScale side of #15. The script
[`infra/planetscale/bootstrap.sh`](../infra/planetscale/bootstrap.sh) creates
the PlanetScale Postgres database, billed through the Cloudflare account, and
its two roles. It follows the inputs settled in
[the Cloudflare deployment design](cloudflare-deployment-design.md) (#28).
Terraform, the Hyperdrive configuration and the deploy pipeline are documented
separately.

## Scope and status

- **Provisioned.** The script was developed offline against stub `pscale`
  and `wrangler` executables, but it has since run for real: it created the
  `scos` database and both roles during a deploy on 2026-09-19
  ([hosted demonstration](hosted-demonstration.md#the-chargeable-step-and-its-date)).
  The database exists and is billing.
- **The deploy runs it.** By the user's decision (the
  [ADR 0005 amendment](adr/0005-cloudflare-first-deployment.md)), the deploy
  job's first step after the build runs this script with
  `CREATE_DATABASE=true`, so a deploy provisions the database and its roles
  when they are missing and does nothing when they exist. Roles are created
  and rotated only there. The manual `planetscale-bootstrap.yml` does dry
  runs and database-only repair.
- **Role credentials live in the Terraform state.** By the user's decision,
  a new role's password goes to the Terraform state in the same deploy, not
  to GitHub secrets: no GitHub secret or variable is written, and there is no
  `ENVIRONMENT_SECRETS_TOKEN`. See
  [role credentials in the state](deployment-pipeline.md#role-credentials-in-the-state).
- **Creating the database starts billing, with no approval.** By the
  user's decisions the `prod` environment has no required reviewers and
  there is no enable flag: every merge to `main` deploys to `prod`, and
  merging with complete settings is the provisioning authorization. The
  first deploy whose settings are complete creates the database and starts
  billing. As of 2026-09-20 every required setting is present, so the next
  merge to `main` does this. The kill switch is disabling
  the `Deploy Prod` workflow (`gh workflow disable deploy-prod.yml`, or
  Actions > Deploy Prod > Disable workflow). The settings are already
  complete, so keep the workflow disabled until ready to pay. Dispatching the
  manual workflow on `main` with `create_database` on also creates the
  database.
- **Ownership.** The script owns the database, its `main` branch settings, the
  runtime and migration roles, and the backup settings. It never deletes
  anything.
- **Relaxed #15 criteria.** This relaxes two of the issue's criteria, by the
  user's decision: the PlanetScale service token is no longer used only by
  the bootstrap workflow (the deploy uses it on every run), and a merge to
  `main` can now create the database (through the deploy). A third is
  relaxed in the run that creates or rotates a role only: its password is
  written to the job's `$GITHUB_ENV` file for the Terraform plan
  ([same-run values](#same-run-values-in-the-deploy)).

## What the script does

1. Checks its inputs and that `pscale` is 0.313.0 or newer.
2. Looks up the database with `pscale database show`.
   - Missing and `CREATE_DATABASE=true`: mints a billing signature with
     `wrangler hyperdrive planetscale signature` and pipes it into:

     ```sh
     pscale database create <db> --engine postgresql --region <region> \
       --cluster-size <size> --major-version 18 --replicas 0 \
       --cloudflare-billing @- --wait
     ```

   - Missing and `CREATE_DATABASE=false`: stops with an error. This is the
     default.
   - Present: leaves it as it is. An existing database is never recreated,
     resized or reconfigured.
3. Waits until the branch is ready, then looks up each role by exact name with
   `pscale role list --name`. A role that exists is left alone unless
   `ROTATE_ROLES` names it. A role that exists but is not `active` stops the
   run.
4. In the deploy only (`EXPORT_GITHUB_ENV=true`): creates each missing role
   with `pscale role create <db> <branch> <name> --inherited-roles …`, and
   resets the password of each role `ROTATE_ROLES` names with
   `pscale role reset <db> <branch> <role-id> --force`. The new credential is
   masked and handed to the deploy's Terraform plan step through
   `$GITHUB_ENV` ([same-run values](#same-run-values-in-the-deploy)), which
   stores it in the Terraform state. Anywhere else a missing role, or a
   rotation, stops the run before anything is created: the one-time password
   would have nowhere to go.
5. Publishes the non-secret connection values, read from PlanetScale on every
   run: the branch host, the runtime username and, when PlanetScale reports
   it (a create or reset), the PostgreSQL database name. They go to the job
   summary and, in the deploy, to `$GITHUB_ENV` as `BOOTSTRAP_*`. Operator
   variables of the same names (`PLANETSCALE_HOST`, `HYPERDRIVE_ORIGIN_USER`,
   `HYPERDRIVE_ORIGIN_DATABASE`) override them; none needs to be set.

Every precondition (versions, Cloudflare account, somewhere for a new
credential to go) is checked before the first create, so a failed check
changes nothing. A second run with everything present makes no create or
reset call and exports no credential.

## Inputs

The script reads environment variables. The workflows fill them from GitHub
variables and secrets; a local run exports the same names.

| Variable                                                     | Workflow source                                                   | Default                               | Notes                                                                                                    |
| ------------------------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `PLANETSCALE_ORG`                                            | repository variable                                               | none, required                        | The run fails at once if empty                                                                           |
| `PLANETSCALE_SERVICE_TOKEN_ID`                               | repository variable                                               | none                                  | Required in Actions; locally `pscale auth login` also works                                              |
| `PLANETSCALE_SERVICE_TOKEN`                                  | repository secret                                                 | none                                  | Read by `pscale` from the environment, never passed as an argument                                       |
| `PLANETSCALE_DATABASE`                                       | `prod` variable                                                   | `scos`                                | PlanetScale database name                                                                                |
| `PLANETSCALE_BRANCH`                                         | `prod` variable                                                   | `main`                                | Production branch; no development branch (#28)                                                           |
| `PLANETSCALE_REGION`                                         | `prod` variable                                                   | `ap-southeast`                        | AWS Singapore (#28)                                                                                      |
| `PLANETSCALE_CLUSTER_SIZE`                                   | `prod` variable                                                   | `PS-5`                                | Must be a SKU name `pscale size cluster list` prints; see [before the first run](#before-the-first-run)  |
| `PLANETSCALE_POSTGRES_MAJOR_VERSION`                         | not set                                                           | `18`                                  | The schema needs `uuidv7()`                                                                              |
| `PLANETSCALE_REPLICAS`                                       | not set                                                           | `0`                                   | Single node; HA would be 2 or more                                                                       |
| `RUNTIME_ROLE_NAME`                                          | not set                                                           | `scos_runtime`                        | Role name, not the connection username                                                                   |
| `RUNTIME_INHERITED_ROLES`                                    | not set                                                           | `pg_read_all_data,pg_write_all_data`  |                                                                                                          |
| `MIGRATION_ROLE_NAME`                                        | `prod` variable                                                   | `scos_migrator`                       |                                                                                                          |
| `MIGRATION_INHERITED_ROLES`                                  | not set                                                           | `postgres`                            | See [roles](#roles)                                                                                      |
| `CREATE_DATABASE`                                            | `true` in the deploy; manual input `create_database`              | `false`                               | `true` may start billing                                                                                 |
| `MANAGE_ROLES`                                               | `true` in the deploy; manual: `true` only for a dry run           | `true`                                | `false` creates only the database                                                                        |
| `ROTATE_ROLES`                                               | the deploy's `rotate_credentials` input                           | `none`                                | `runtime`, `migration` or `both`: reset those roles' passwords; deploy only                              |
| `ORIGIN_DATABASE_FALLBACK`                                   | deploy: `HYPERDRIVE_ORIGIN_DATABASE`, the stored name, `postgres` | `postgres`                            | Database name for a migration URL when `role reset` does not report one                                  |
| `DRY_RUN`                                                    | manual input `dry_run`                                            | `false`                               | Reports the plan and changes nothing                                                                     |
| `EXPORT_GITHUB_ENV`                                          | `true` in the deploy job only                                     | `false`                               | Exports `BOOTSTRAP_*` values to `$GITHUB_ENV`; needs Actions. Required to create or reset a role         |
| `CLOUDFLARE_ACCOUNT_ID`                                      | `prod` variable                                                   | none                                  | Needed only when creating; must match the signature's account                                            |
| `CLOUDFLARE_API_TOKEN`                                       | `prod` secret (deploy; manual: database-creating runs only)       | none                                  | The one Cloudflare token; this script uses it only for the signature, only while the database is missing |
| `WRANGLER_CMD`                                               | not set                                                           | `apps/api/node_modules/.bin/wrangler` | The lockfile-pinned Wrangler; see [the billing signature](#the-cloudflare-billing-signature)             |
| `BRANCH_READY_TIMEOUT_SECONDS` / `BRANCH_READY_POLL_SECONDS` | not set                                                           | `900` / `15`                          |                                                                                                          |

## Before the first run

These are operator actions. None is automated.

1. **Restrict the `prod` environment's deployment branches to `main`**
   (Deployment branches and tags > Selected branches). Both workflows already
   refuse any ref but `refs/heads/main`: a `preflight` step fails, and the
   `prod` job has `if: github.ref == 'refs/heads/main'`. The environment rule
   also covers any other workflow that names `prod`, so a branch's modified
   script can never run with prod secrets.
2. **Set the `PLANETSCALE_ORG` repository variable.**
3. **Give the PlanetScale service token only what the bootstrap needs.**
   `create_databases` and `read_databases` on the organization; then, on the
   `scos` database once it exists, `read_database`, `read_branch` and
   `create_production_branch_password` (`pscale role create` names
   `create_branch_password` or `create_production_branch_password`; `pscale
role reset` needs the same). Whether a token holding `create_databases`
   can manage the database it just created without a further grant is
   unverified; if role creation fails with `NOT_FOUND` after the database was
   created, add the database accesses and run the deploy again (the roles
   were not created, so nothing is lost). Only the deploy job and the manual
   bootstrap use this token, never pull-request jobs.
4. **Confirm the cluster size SKU.** `pscale database create --cluster-size`
   takes a SKU name, not a marketing name. List what `ap-southeast` offers for
   Postgres and set `PLANETSCALE_CLUSTER_SIZE` to the PS-5 entry if it is not
   literally `PS-5`:

   ```sh
   pscale size cluster list --engine postgresql --region ap-southeast --org "$PLANETSCALE_ORG" --format json
   ```

   Also confirm PostgreSQL 18 is offered there (#28 left this unchecked). If it
   is not, `pscale database create` fails and nothing is billed.

## Where role credentials go

A role's password is shown once, by `pscale role create` or `pscale role
reset`. The script never prints it, never passes it as an argument and never
writes it to a GitHub secret or variable. In the deploy it registers the
value with `::add-mask::` (on stderr, which the runner reads for workflow
commands) and appends it to `$GITHUB_ENV`. The deploy's next step stores it
in the Terraform state at once, with a targeted apply, and clears it
([why](deployment-pipeline.md#role-credentials-in-the-state)):

| Stored in the state as                               | Value                                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `terraform_data.planetscale_runtime_password`        | The runtime role's password; Hyperdrive's origin password                                   |
| `terraform_data.migration_database_url` (and output) | `postgresql://<user>:<password>@<branch host>:5432/<database>?sslmode=require`, URL-encoded |

The state is the only copy: its pre-apply backups are also the credential
backups, and losing it means restoring a backup or rotating both roles
([deployment pipeline](deployment-pipeline.md#role-credentials-in-the-state)).

**Local runs** (`pscale auth login`, or the service token) can dry-run, and
can create the database with `MANAGE_ROLES=false`:

```sh
export PLANETSCALE_ORG=<org> PLANETSCALE_SERVICE_TOKEN_ID=<id> PLANETSCALE_SERVICE_TOKEN=<token>
DRY_RUN=true infra/planetscale/bootstrap.sh
CREATE_DATABASE=true MANAGE_ROLES=false CLOUDFLARE_ACCOUNT_ID=<id> infra/planetscale/bootstrap.sh
```

A local run never creates or resets a role. Do not run it with `bash -x`.

## After the run

Nothing needs copying by hand. The deploy reads the branch host, the runtime
username and (when reported) the database name from PlanetScale on every run.
Set these `prod` variables only to override what PlanetScale reports:

| Variable                     | Overrides                                                                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `PLANETSCALE_HOST`           | The branch host (`access_host_url`)                                                                                                 |
| `HYPERDRIVE_ORIGIN_USER`     | The runtime role's connection **username** as `pscale` reports it. It may differ from the role name, for example by a branch suffix |
| `HYPERDRIVE_ORIGIN_DATABASE` | The PostgreSQL database name. Unset, Terraform takes it from the stored migration URL (usually `postgres`, not `scos`)              |

## Same-run values in the deploy

With `EXPORT_GITHUB_ENV=true` the script appends, for the rest of that one
job:

| `$GITHUB_ENV` name                       | When                                        | Consumer                                                         |
| ---------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------- |
| `BOOTSTRAP_PLANETSCALE_RUNTIME_PASSWORD` | The runtime role was created or reset now   | The store step (targeted apply with `-replace`), which clears it |
| `BOOTSTRAP_MIGRATION_DATABASE_URL`       | The migration role was created or reset now | The store step (targeted apply with `-replace`), which clears it |
| `BOOTSTRAP_PLANETSCALE_HOST`             | Every run                                   | Terraform plan, the migration URL check                          |
| `BOOTSTRAP_HYPERDRIVE_ORIGIN_USER`       | Every run                                   | Terraform plan                                                   |
| `BOOTSTRAP_HYPERDRIVE_ORIGIN_DATABASE`   | When PlanetScale reported it                | Terraform plan                                                   |

This relaxes the issue's "never a file" rule for role passwords, by the
user's decision, within these limits:

- **Only when issued.** A credential is exported only in the run that created
  or reset the role. Any other run exports only the host and username.
- **Masked first.** Each value is registered with `::add-mask::` before it is
  written, so a later print is redacted.
- **Runner-local.** `$GITHUB_ENV` is a file in the runner's temporary
  directory, private to the job, never uploaded, and discarded with the
  runner. It is the same class of exposure as the saved Terraform plan, which
  holds the same values.
- **Only as long as needed.** The store step right after the bootstrap
  clears both credential names, so no other step (the database settings check, plan,
  apply, migrations, the Worker configuration, `wrangler deploy`, the health
  check) has them in its environment. Backend init and the state backup run
  before the bootstrap.
- Values are single-line; a value containing a newline is refused, so it
  cannot inject another variable.
- **If the store step fails** (or the job dies inside the bootstrap step
  after creating a role but before exporting it), the fresh credential is
  lost with the runner, and the role in PlanetScale has a password nothing
  holds. The next plan says so; rotate that role (below). A state backup does
  not help: it predates the new password.

## The Cloudflare billing signature

- **Experimental.** Cloudflare marks
  `wrangler hyperdrive planetscale signature` as experimental; its interface
  may change. `pscale` hides the matching `--cloudflare-billing` flag from
  `--help` (it exists in 0.337.0).
- **Wrangler version.** The command first shipped in Wrangler 4.126.0. The
  script uses the repository's lockfile-pinned Wrangler, 4.135.0 in
  `apps/api/package.json`, from `apps/api/node_modules/.bin/wrangler`, and
  refuses anything older than 4.126.0. Run `pnpm install --frozen-lockfile`
  first. The workflow does that in setup steps that have no secrets in their
  environment, only for a run that creates the database. `WRANGLER_CMD`
  overrides the binary.
- **A credential.** The script captures the signature in memory, masks it in
  Actions, checks that its `account_id` equals `CLOUDFLARE_ACCOUNT_ID`, and
  pipes it to `pscale` on stdin. It is never echoed, written to disk or passed
  as an argument, and the script never enables `set -x`.
- **Unverified: non-interactive use with a scoped token.** Whether the
  command works from Actions with a scoped `CLOUDFLARE_API_TOKEN`, and which
  token permission it needs (Hyperdrive edit is the likely one), could not be
  checked without an account. The first real run is the check. Try it
  locally with `DRY_RUN=false CREATE_DATABASE=true` if in doubt.
- **Fallback: create the database in the dashboard.** In the Cloudflare
  dashboard, Workers > Hyperdrive > Create a PlanetScale database, choose
  Postgres, PostgreSQL 18, `ap-southeast`, PS-5 single node and the name
  `scos`. Then run the workflow with `create_database` off: it finds the
  database and manages only the roles.

## Roles

**Runtime role** (`scos_runtime`, inherits `pg_read_all_data,pg_write_all_data`).
Hyperdrive's origin credential. It reads and writes every table, including
tables added by later migrations, and has no DDL rights (#28).

**Migration role** (`scos_migrator`, inherits `postgres`). `prisma migrate
deploy` creates and alters tables, indexes, a trigger function and triggers in
`public`, and writes `_prisma_migrations`. That needs `CREATE` on `public` and
ownership of the objects it later alters. PlanetScale documents three
inheritable roles for Postgres: `pg_read_all_data`, `pg_write_all_data` and
`postgres`. Only `postgres` grants DDL; PlanetScale describes it as close to a
superuser, without `SUPERUSER`. The narrower alternative, the two data roles
plus `GRANT CREATE ON SCHEMA public`, needs an administrative SQL session
outside the CLI, and still leaves ownership with whichever role created each
object. The migration role therefore inherits `postgres`, and stays separate
from the runtime role and from the default `postgres` credential. Objects it
creates are owned by it; if the role is ever deleted, `pscale role reassign`
must move them first.

**TLS.** PlanetScale Postgres accepts TLS connections. The migration URL
carries `sslmode=require`. node-postgres (the seed) treats `require` as full
certificate verification and logs a warning saying so. Hyperdrive's default
is also `sslmode=require` with certificate validation (#28).

## Rotation

A re-run never resets a password. Rotation goes through the deploy, which
resets the role and replaces the stored credential in one run:

1. Run **Deploy Prod** manually on `main` with `rotate_credentials` set to
   `runtime`, `migration` or `both`.
2. The bootstrap step resets the role (`pscale role reset … --force`) and
   exports the new credential, masked. The next step stores it in the state
   with a targeted apply and `-replace=terraform_data.<name>`; for the
   runtime role, the full apply later in the run updates Hyperdrive's origin
   password. For the migration role, the URL's database name comes from the
   reset output, else `HYPERDRIVE_ORIGIN_DATABASE`, else the name in the
   stored URL, else `postgres` (`ORIGIN_DATABASE_FALLBACK`).
3. The old password stops working at step 2, so the Worker fails database
   calls until the full apply finishes (a minute or two). Rotate outside a
   demonstration. If the run fails after the store step, rerun the deploy
   without rotating. If the store step itself failed, rotate again: no state
   backup holds the new password.

Without `-replace`, a new value is ignored and the stored one kept, so a
stray `TF_VAR_*` can never overwrite a credential. A replace with no new
value fails the plan.

## Backups

PlanetScale Postgres takes automatic backups every 12 hours on production and
development branches and keeps them for 2 days. Automatic backups are included
at no charge; each branch gets backup storage of twice its disk size before
overage charges. Custom schedules and on-demand backups can cost extra.

This suits a disposable demo: the data is six seeded warehouses and a few
Orders, and losing up to 12 hours of demo Orders is acceptable. No change is
made, and the script does not manage backup schedules (the CLI has no command
for them). Restoring a backup is database recovery, separate from rolling back
a Worker version. Whether backups survive `pscale database delete` is not
documented; assume they do not.

## Seeding demonstration data

The migration role's URL now lives only in the Terraform state, so the seed
runs inside the deploy: run **Deploy Prod** manually on `main` with
`seed_demo_data` checked. After `prisma migrate deploy`, the migration step
runs `pnpm --filter @scos/persistence db:seed` with the same URL, directly to
the branch. A push never seeds, and Worker startup never seeds.

The seed inserts the six PRD warehouses with `ON CONFLICT (id) DO NOTHING`
(`packages/persistence/src/seed.ts`). Existing rows, and therefore consumed
stock, are never changed. A rerun reports `0 inserted, 6 already present`. A
warehouse name that exists under a different id fails the seed instead of
overwriting it.

Order on first deployment: the first deploy (which creates the database and
its roles, applies Terraform and the migrations, and deploys the Worker), then
a manual deploy with `seed_demo_data`, or `seed_demo_data` on the first run
itself if it is started by hand.

There is no separate seed workflow: the migration URL lives only in the
Terraform state, which only the deploy reads.

## Teardown

Deleting the database is what stops PlanetScale billing, and it is never
automated. First disable the `Deploy Prod` workflow
(`gh workflow disable deploy-prod.yml`) and keep it disabled: the deploy
creates a missing database, so the next merge would otherwise provision a
new, empty one and start billing again. Then, after the
Worker and Terraform resources are removed, an operator runs
`pscale database delete <db> --org <org>`. All data, and probably its
backups, are lost. The role credentials go with the Terraform state
(`terraform destroy` removes them from it); delete any operator override
variables (`PLANETSCALE_HOST`, `HYPERDRIVE_ORIGIN_USER`,
`HYPERDRIVE_ORIGIN_DATABASE`) too, or a later re-creation uses stale values.

## Tests

```sh
bash infra/planetscale/test/bootstrap.test.sh
```

It puts stub `pscale` and `wrangler` executables (in
`infra/planetscale/test/stubs/`) first on `PATH`, with a `gh` tripwire that
fails any call, and checks that:

- a deploy-mode first run (`EXPORT_GITHUB_ENV=true` under Actions) creates
  the database (with the billing proof on stdin) and both roles, and exports
  both new credentials to `$GITHUB_ENV`, each masked first, plus the host,
  username and database name;
- a re-run makes no create or reset call and exports only the host and
  username, never a credential;
- `ROTATE_ROLES` resets only the named roles and exports only their new
  credentials; rotating a missing role creates it; a reset without a password
  exports nothing; a migration reset without a database name uses
  `ORIGIN_DATABASE_FALLBACK` (default `postgres`), and an unsafe fallback is
  refused;
- outside the deploy, a missing role or a rotation stops the run before any
  create or reset, and `MANAGE_ROLES=false` creates only the database;
- an existing database gets only its missing role;
- `role create` output missing `password` or `access_host_url` fails the
  run and exports nothing, rather than the string `null`;
- the migration URL uses the configured database name (`postgres` unless
  overridden), because `pscale`'s role output has no `database_name`;
- the signature, passwords and tokens never appear in stdout or stderr,
  except in `::add-mask::` lines under Actions, and the signature and tokens
  never reach `$GITHUB_ENV`;
- the script never calls `gh`;
- a missing organization, an old `pscale` or Wrangler, an uninstalled
  Wrangler, a missing database without `CREATE_DATABASE=true`, a mismatched
  signature account, an unknown `ROTATE_ROLES` value and export mode outside
  Actions all exit non-zero before any create.

Lint with shellcheck:

```sh
docker run --rm -v "$PWD:/mnt" -w /mnt koalaman/shellcheck:stable \
  infra/planetscale/bootstrap.sh infra/planetscale/test/bootstrap.test.sh infra/planetscale/test/stubs/*
```

## Unverified until the first real run

- The billing signature from Actions with a scoped `CLOUDFLARE_API_TOKEN`, and
  the permission it needs.
- The `PS-5` SKU name and PostgreSQL 18 availability in `ap-southeast`.
- The exact JSON `pscale` prints for `database show`, `branch show`,
  `role list`, `role create` and `role reset` against the real API (whether
  `role reset` reports `username` and `access_host_url`; the script falls
  back to `role list` for them). The script relies on fields read from the
  `pscale` 0.337.0 source (`kind`, `ready`, `name`, `status`, `username`,
  `password`, `access_host_url`) and on the `NOT_FOUND` error code. Role
  output has no `database_name` (the first real deploy, 2026-09-20, failed on
  that assumption): `pscale`'s own `database_url` always uses `postgres`, and
  the script uses the configured name, `postgres` by default.
- The service-token accesses needed after the token creates the database.
- That a role inheriting `postgres` can run the initial migration.

## Sources

Checked on 2026-09-19.

- [PlanetScale Postgres and MySQL with Hyperdrive](https://developers.cloudflare.com/hyperdrive/planetscale/)
- [Wrangler 4.126.0 release notes](https://github.com/cloudflare/workers-sdk/releases/tag/wrangler%404.126.0)
- `pscale help agents` (0.337.0) and the [PlanetScale CLI source](https://github.com/planetscale/cli)
- [PlanetScale Postgres roles](https://planetscale.com/docs/postgres/connecting/roles)
- [PlanetScale Postgres backups](https://planetscale.com/docs/postgres/backups)
- [PlanetScale service tokens](https://planetscale.com/docs/api/reference/service-tokens)
- [GitHub App permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps) (`GET /repos/{owner}/{repo}/environments/{name}` needs Actions: read)
