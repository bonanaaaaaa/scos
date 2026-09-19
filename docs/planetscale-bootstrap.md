# PlanetScale bootstrap

This is the runbook for the PlanetScale side of #15. The script
[`infra/planetscale/bootstrap.sh`](../infra/planetscale/bootstrap.sh) creates
the PlanetScale Postgres database, billed through the Cloudflare account, and
its two roles. It follows the inputs settled in
[the Cloudflare deployment design](cloudflare-deployment-design.md) (#28).
Terraform, the Hyperdrive configuration and the deploy pipeline are documented
separately.

## Scope and status

- **Offline preparation only.** Nothing has been provisioned. The script was
  tested with stub `pscale`, `wrangler` and `gh` executables, never against
  PlanetScale or Cloudflare.
- **Running it with `CREATE_DATABASE=true` starts billing.** The approval on
  the workflow's `prod` environment is the provisioning authorization.
- **Ownership.** The script owns the database, its `main` branch settings, the
  runtime and migration roles, and the backup settings. It never deletes
  anything.

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
   `pscale role list --name`. A role that exists is left alone; its password is
   never reset. A role that exists but is not `active` stops the run.
4. Creates each missing role with
   `pscale role create <db> <branch> <name> --inherited-roles …` and
   immediately stores its credential as a GitHub `prod` environment secret
   with `gh secret set` (value on stdin).
5. Prints the non-secret connection values the operator needs next (and adds
   them to the job summary in Actions).

Every precondition (versions, Cloudflare account, secret sink) is checked
before the first create, so a failed check changes nothing. A second run with
everything present makes no create or reset call.

## Inputs

The script reads environment variables. The workflow fills them from GitHub
variables and secrets; a local run exports the same names.

| Variable                                                     | Workflow source                                             | Default                              | Notes                                                                                                   |
| ------------------------------------------------------------ | ----------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `PLANETSCALE_ORG`                                            | repository variable                                         | none, required                       | The run fails at once if empty                                                                          |
| `PLANETSCALE_SERVICE_TOKEN_ID`                               | repository variable                                         | none                                 | Required in Actions; locally `pscale auth login` also works                                             |
| `PLANETSCALE_SERVICE_TOKEN`                                  | repository secret                                           | none                                 | Read by `pscale` from the environment, never passed as an argument                                      |
| `PLANETSCALE_DATABASE`                                       | `prod` variable                                             | `scos`                               | PlanetScale database name                                                                               |
| `PLANETSCALE_BRANCH`                                         | `prod` variable                                             | `main`                               | Production branch; no development branch (#28)                                                          |
| `PLANETSCALE_REGION`                                         | `prod` variable                                             | `ap-southeast`                       | AWS Singapore (#28)                                                                                     |
| `PLANETSCALE_CLUSTER_SIZE`                                   | `prod` variable                                             | `PS-5`                               | Must be a SKU name `pscale size cluster list` prints; see [before the first run](#before-the-first-run) |
| `PLANETSCALE_POSTGRES_MAJOR_VERSION`                         | not set                                                     | `18`                                 | The schema needs `uuidv7()`                                                                             |
| `PLANETSCALE_REPLICAS`                                       | not set                                                     | `0`                                  | Single node; HA would be 2 or more                                                                      |
| `RUNTIME_ROLE_NAME`                                          | not set                                                     | `scos_runtime`                       | Role name, not the connection username                                                                  |
| `RUNTIME_INHERITED_ROLES`                                    | not set                                                     | `pg_read_all_data,pg_write_all_data` |                                                                                                         |
| `MIGRATION_ROLE_NAME`                                        | `prod` variable                                             | `scos_migrator`                      |                                                                                                         |
| `MIGRATION_INHERITED_ROLES`                                  | not set                                                     | `postgres`                           | See [roles](#roles)                                                                                     |
| `CREATE_DATABASE`                                            | input `create_database`                                     | `false`                              | `true` may start billing                                                                                |
| `MANAGE_ROLES`                                               | input `manage_roles`                                        | `true`                               | `false` creates only the database                                                                       |
| `DRY_RUN`                                                    | input `dry_run`                                             | `false`                              | Reports the plan and changes nothing                                                                    |
| `CLOUDFLARE_ACCOUNT_ID`                                      | `prod` variable                                             | none                                 | Needed only when creating; must match the signature's account                                           |
| `CLOUDFLARE_API_TOKEN`                                       | `prod` secret, passed only to a database-creating run       | none                                 | Used only by the Wrangler signature command                                                             |
| `SECRETS_REPO`                                               | `github.repository` when `ENVIRONMENT_SECRETS_TOKEN` is set | empty                                | Where new role credentials are stored; empty means missing roles cannot be created                      |
| `SECRETS_ENVIRONMENT`                                        | `prod`                                                      | `prod`                               |                                                                                                         |
| `GH_TOKEN`                                                   | `prod` secret `ENVIRONMENT_SECRETS_TOKEN`                   | local `gh` login                     | See [storing role credentials](#storing-role-credentials)                                               |
| `WRANGLER_VERSION` / `WRANGLER_CMD`                          | not set                                                     | `4.135.0` / `npx`                    | See [the billing signature](#the-cloudflare-billing-signature)                                          |
| `BRANCH_READY_TIMEOUT_SECONDS` / `BRANCH_READY_POLL_SECONDS` | not set                                                     | `900` / `15`                         |                                                                                                         |

## Before the first run

These are operator actions. None is automated.

1. **Add a required reviewer to the `prod` environment** (Settings >
   Environments > prod). It has none today. The workflow's `preflight` job
   reads the environment through the API (`GITHUB_TOKEN` with
   `actions: read`) and fails when no `required_reviewers` rule exists.
   Consider turning off "Allow administrators to bypass configured protection
   rules"; it is on, so an administrator can skip the approval.
2. **Restrict the `prod` environment's deployment branches to `main`**
   (Deployment branches and tags > Selected branches). Both workflows already
   refuse any ref but `refs/heads/main`: a `preflight` step fails, and the
   `prod` job has `if: github.ref == 'refs/heads/main'`. The environment rule
   also covers any other workflow that names `prod`, so a branch's modified
   script can never run with prod secrets.
3. **Set the `PLANETSCALE_ORG` repository variable.**
4. **Give the PlanetScale service token only what the bootstrap needs.**
   `create_databases` and `read_databases` on the organization; then, on the
   `scos` database once it exists, `read_database`, `read_branch` and
   `create_production_branch_password` (`pscale role create` names
   `create_branch_password` or `create_production_branch_password`). Whether a
   token holding `create_databases` can manage the database it just created
   without a further grant is unverified; if role creation fails with
   `NOT_FOUND` after the database was created, add the database accesses and
   rerun. The deploy workflow and pull-request jobs never use this token.
5. **Confirm the cluster size SKU.** `pscale database create --cluster-size`
   takes a SKU name, not a marketing name. List what `ap-southeast` offers for
   Postgres and set `PLANETSCALE_CLUSTER_SIZE` to the PS-5 entry if it is not
   literally `PS-5`:

   ```sh
   pscale size cluster list --engine postgresql --region ap-southeast --org "$PLANETSCALE_ORG" --format json
   ```

   Also confirm PostgreSQL 18 is offered there (#28 left this unchecked). If it
   is not, `pscale database create` fails and nothing is billed.

6. **Choose how role credentials are stored** (next section).

## Storing role credentials

A role's password is shown once, by `pscale role create`. The script never
prints it, never writes it to a file and never passes it as an argument. It
pipes it into `gh secret set <NAME> --env prod --repo <repo>`:

| Secret (`prod` environment)  | Value                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `HYPERDRIVE_ORIGIN_PASSWORD` | The runtime role's password                                                                 |
| `MIGRATION_DATABASE_URL`     | `postgresql://<user>:<password>@<branch host>:5432/<database>?sslmode=require`, URL-encoded |

In Actions the script first registers each value with `::add-mask::`, so a
later accidental print is redacted. The masking command is written to stderr,
which the runner reads for workflow commands just as it reads stdout.

The default `GITHUB_TOKEN` cannot write secrets. Two ways to provide a
credential that can:

- **Workflow path.** Create a fine-grained personal access token with access
  to this repository only and one permission: **Environments: Read and
  write** (Metadata: Read is added automatically). That covers reading the
  environment's public key, listing its secrets and writing them. Store it as
  the `prod` environment secret `ENVIRONMENT_SECRETS_TOKEN`, so only the
  approved job receives it. Give it a short expiry and delete it after the
  bootstrap. Note that the token can write every environment's secrets in
  this repository, not only `prod`'s.
- **Local path.** Leave `ENVIRONMENT_SECRETS_TOKEN` unset. With
  `manage_roles` on (the default), the workflow then stops before creating
  anything, the database included, because a missing role would have nowhere
  to put its password. Run it with `manage_roles` off to create only the
  database. Create the roles by running the script on a workstation where
  `gh` is logged in as a repository administrator:

  ```sh
  export PLANETSCALE_ORG=<org> PLANETSCALE_SERVICE_TOKEN_ID=<id> PLANETSCALE_SERVICE_TOKEN=<token>
  export SECRETS_REPO=bonanaaaaaa/scos
  infra/planetscale/bootstrap.sh
  ```

  Add `CREATE_DATABASE=true CLOUDFLARE_ACCOUNT_ID=<id>` (and
  `CLOUDFLARE_API_TOKEN`, or a `wrangler login` session) to create the
  database in the same run. Do not run it with `bash -x`.

If `gh secret set` fails after a role was created, the run stops and the
password is lost by design. [Rotate](#rotation) that role to recover.

## After the run

Set these `prod` environment **variables** from the run's summary. They are
not secret.

| Variable                 | Value                                                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `PLANETSCALE_HOST`       | The branch host (`access_host_url`)                                                                                                 |
| `HYPERDRIVE_ORIGIN_USER` | The runtime role's connection **username** as `pscale` reports it. It may differ from the role name, for example by a branch suffix |

The PostgreSQL database name to connect to (`database_name`, which may be
`postgres` rather than `scos`) is printed as well. Hyperdrive's origin uses
it, not the PlanetScale database name. Then run Terraform, the deploy and the
seed.

## The Cloudflare billing signature

- **Experimental.** Cloudflare marks
  `wrangler hyperdrive planetscale signature` as experimental; its interface
  may change. `pscale` hides the matching `--cloudflare-billing` flag from
  `--help` (it exists in 0.337.0).
- **Wrangler version.** The command first shipped in Wrangler 4.126.0. The
  repository pins Wrangler 4.124.0 in `apps/api/package.json`, which does not
  have it. The workflow installs `wrangler@4.135.0` in its own step, which
  has no secrets in its environment, with `npm install --ignore-scripts` so
  no package install script runs; it passes that binary to the script as
  `WRANGLER_CMD`. A local run without `WRANGLER_CMD` uses
  `npx --yes wrangler@4.135.0`. The script refuses anything older than
  4.126.0. Once `apps/api` pins 4.126.0 or newer, `WRANGLER_CMD` can point
  at that binary.
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

A rerun never resets a password. To rotate a role:

1. Find its id: `pscale role list <db> main --name <role> --org <org> --format json`.
2. Reset it and store the new value without printing it. `jq -e` with
   `require` fails on a missing field, and `&&` then skips `gh`, so the
   string `null` or an empty value is never stored:

   ```sh
   reset="$(pscale role reset <db> main <role-id> --org <org> --format json --force)"
   require='def require($k): if (.[$k] | type) == "string" and (.[$k] | length) > 0 then .[$k] else error("missing field \($k)") end;'

   # Runtime role
   value="$(jq -er "$require"' require("password")' <<<"$reset")" &&
     printf '%s' "$value" | gh secret set HYPERDRIVE_ORIGIN_PASSWORD --env prod --repo bonanaaaaaa/scos

   # Migration role
   value="$(jq -er "$require"' "postgresql://\(require("username") | @uri):\(require("password") | @uri)@\(require("access_host_url")):5432/\(require("database_name"))?sslmode=require"' <<<"$reset")" &&
     printf '%s' "$value" | gh secret set MIGRATION_DATABASE_URL --env prod --repo bonanaaaaaa/scos

   unset reset value
   ```

   If `jq` fails, the new password is only in `$reset`. Check which fields
   came back with `jq 'keys' <<<"$reset"` (names only), never by printing
   the object.

3. For the runtime role, re-apply Terraform so Hyperdrive picks up the new
   password. The old password stops working at step 2, so the Worker fails
   database calls until step 3 completes. Rotate outside a demonstration.

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

`.github/workflows/seed-demo-data.yml` is a separate, manual job bound to the
`prod` environment. It:

1. requires the operator to type the database name as confirmation;
2. connects with `MIGRATION_DATABASE_URL`, directly to the branch;
3. runs `prisma migrate status` and stops if any migration is pending or
   failed (migrations belong to the deploy pipeline);
4. runs `pnpm --filter @scos/persistence db:seed`.

The seed inserts the six PRD warehouses with `ON CONFLICT (id) DO NOTHING`
(`packages/persistence/src/seed.ts`). Existing rows, and therefore consumed
stock, are never changed. A rerun reports `0 inserted, 6 already present`. A
warehouse name that exists under a different id fails the seed instead of
overwriting it. The deploy workflow and Worker startup never seed.

Order on first deployment: bootstrap, Terraform apply, deploy (which applies
migrations), then this seed.

The workflow runs only from `main`. It shares the concurrency group
`seed-demo-data-prod` with the deploy workflow's migration job, and GitHub
keeps only one pending job per group: a newcomer cancels the pending one. So
that a seed never cancels a pending, approved deploy job, a `preflight` job
without a concurrency group first fails if any `Deploy` run (`deploy.yml`) is
`requested`, `queued`, `pending`, `waiting` or `in_progress` (read with
`GITHUB_TOKEN`, `actions: read`). Only then does the seed job claim the group.

A race remains: a deploy dispatched or triggered between that check and the
seed job entering the group can still have its pending migration job
cancelled. The window is seconds, and while the seed waits for its own
approval, a deploy arriving cancels the seed instead, which is harmless. Seed
when no deploy is expected, and rerun a cancelled deploy.

## Teardown

Deleting the database is what stops PlanetScale billing, and it is never
automated. After the Worker and Terraform resources are removed, an operator
runs `pscale database delete <db> --org <org>`. All data, and probably its
backups, are lost.

## Tests

```sh
bash infra/planetscale/test/bootstrap.test.sh
```

It puts stub `pscale`, `wrangler` and `gh` executables (in
`infra/planetscale/test/stubs/`) first on `PATH` and checks that:

- a first run creates the database (with the billing proof on stdin) and both
  roles, and stores both secrets with the right values;
- a second run makes no create or reset call and writes no secret;
- an existing database gets only its missing role;
- `role create` output missing `password`, `database_name` or
  `access_host_url` fails the run and stores no secret, rather than storing
  the string `null`;
- the signature, passwords and tokens never appear in stdout or stderr, except
  in `::add-mask::` lines under Actions;
- a missing organization, an old `pscale` or Wrangler, a missing database
  without `CREATE_DATABASE=true`, a mismatched signature account, and a
  missing or unreadable secret sink all exit non-zero before any create.

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
  `role list` and `role create` against the real API. The script relies on
  fields read from the `pscale` 0.337.0 source (`kind`, `ready`, `name`,
  `status`, `username`, `password`, `access_host_url`, `database_name`) and on
  the `NOT_FOUND` error code.
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
- [Fine-grained token permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)
- [GitHub App permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps) (`GET /repos/{owner}/{repo}/environments/{name}` needs Actions: read)
