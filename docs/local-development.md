# Local development

These scripts follow the one-time setup / daily startup pattern from
[ed-creative-fusion](https://github.com/amity-arac/ed-creative-fusion), adapted to
SCOS. Each agent can prepare and run its own worktree while sharing the local
PostgreSQL container.

## First run in each worktree

Install the Node.js version in `.node-version`, pnpm, and Docker with
Compose v2. Start Docker, then run:

```sh
./setup.sh
./dev.sh
```

`setup.sh` checks prerequisites, checks that pnpm switches to the pinned version,
installs with a frozen lockfile, and creates `.env` only if absent. Existing
configuration is preserved. Rerun setup when dependencies change. Both scripts
resolve paths from their own location, so they work from another directory.

## Shared PostgreSQL, separate worktree databases

`dev.sh` reuses a running PostgreSQL container. If none is running, it starts an
existing stopped one. If none exists, it starts the scaffold's `postgres`
service under the fixed Compose project name `scos-local`. Every worktree shares
that one container and persistent volume. Only the development service starts;
the disposable test database is excluded.

Discovery recognizes Compose services named `postgres` and ordinary containers
using the official PostgreSQL image. If several candidates exist, or a custom
image is used, select the shared development container explicitly:

```sh
SCOS_POSTGRES_CONTAINER=my-postgres ./dev.sh
```

The container must publish PostgreSQL port 5432 to localhost. The scaffold uses
host port 5432 when creating the shared container. The launcher waits for
PostgreSQL readiness, reads
its configured PostgreSQL user and password (including `POSTGRES_PASSWORD_FILE`)
and discovers the published host port. Set `SCOS_POSTGRES_PASSWORD` if the actual
password differs from the container's initialization configuration. Local `psql`
inside the container must be able to authenticate as that user and create databases.

The container must run PostgreSQL 18 or newer, because the schema's generated
IDs use the built-in `uuidv7()` function introduced in PostgreSQL 18. The
scaffold's Compose services use `postgres:18.1-alpine`. Before migrating, the
launcher checks `SHOW server_version_num` and stops with an error if it is
below 180000.

Each worktree gets a database named `scos_wt_<hash>`, derived from its absolute
path. The database is created only if missing, with an advisory lock protecting
simultaneous initialization. Existing data is preserved. Different worktrees
use different databases within the same container; repeated launches reuse the
same database. Moving a worktree changes its database identity.

The launcher exports the generated `DATABASE_URL` to the API, overriding copied
or inherited database URLs without editing `.env`. It does not log the password.
The API requires `DATABASE_URL` and validates it (and `PORT`) at startup: a
missing or malformed value stops it with a nonzero exit before it listens, and
the value is never printed. Outside the launcher, export `DATABASE_URL` before
`pnpm api:dev` or `api:start`; Turbo passes `DATABASE_URL` and `PORT`
through to both tasks.
Before starting the API it runs `db:seed`, which applies pending migrations and
inserts any missing seed warehouses. Both steps are idempotent: repeated
launches never reset data or replenish consumed stock. Integration-test
database setup remains separate.

## Migrations, seed, and reset

These commands act on the database named by `DATABASE_URL`. Prisma 7 does not
read `.env`, so export the URL first (the launcher does this for the worktree
database).

```sh
pnpm db:migrate   # apply pending migrations
pnpm db:seed      # apply migrations, then insert missing warehouses
SCOS_CONFIRM_DATABASE_RESET=<database-name> pnpm db:reset
```

`db:reset` is the only destructive command. It refuses to run unless
`SCOS_CONFIRM_DATABASE_RESET` matches the database name in `DATABASE_URL`
exactly. It then drops all data, reapplies migrations, and reseeds. A person
must run it: Prisma 7 blocks `prisma migrate reset` when it detects an AI coding
agent unless the user explicitly consents, so agents should ask a human to run
`db:reset` rather than working around that check. See
[database schema](database-schema.md) for tables, relationships, and schema
decisions.

## API ports and shutdown

Like the reference script, the launcher checks ports in order, starting at 3000,
and increments until it finds an available one. Set `PORT` in `.env` or the shell
to change the starting point; the shell wins. `.env` is parsed as data, not
executed as shell code.

```sh
PORT=8080 ./dev.sh
```

The selected URL is printed before Turbo starts the API in watch mode and builds
its dependencies. Turbo's local development task uses loose environment mode
so the generated database URL reaches the API. Check `/health` at the printed URL,
and open `/docs` there for interactive API documentation (Swagger UI over
`/openapi.json`).

## API specification

hono-openapi generates the OpenAPI document from the API's route contracts
(attached to each route with `describeRoute`). It is not committed: `pnpm build`
writes it to `apps/api/dist/openapi.json`, the same bytes the API serves at
`/openapi.json`. To write it without a full build (no running server or database
needed):

```sh
pnpm openapi:export   # write apps/api/dist/openapi.json
```

## Install and verify

```sh
pnpm install --frozen-lockfile
pnpm exec tsc --version
pnpm build
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
```

The compiler command must report `Version 7.0.2`. The separate quality commands build every package, type-check, lint with Oxlint, check formatting and import order with Oxfmt, and run the current Vitest suites through Turbo. Each unit suite enforces at least 80% statement, branch, function, and line coverage. Coverage summaries are written to `coverage/` at the repository root and in each tested package.

Installing dependencies also enables the [husky](https://typicode.github.io/husky/) `pre-commit` hook in `.husky` (the `prepare` script runs `husky`). Before each commit, [lint-staged](https://github.com/lint-staged/lint-staged) formats the staged files with Oxfmt, re-stages them, and lints the staged JavaScript and TypeScript with Oxlint (configured under `lint-staged` in `package.json`); the hook then runs the Turbo typecheck for the whole workspace as CI does. Use `git commit --no-verify` to skip it for a single commit, or `HUSKY=0` to disable hooks.

Every directory's job is listed in the
[repository map](architecture.md#repository-map); the hexagonal layering, the
dependency rule and where new code belongs are in
[architecture](architecture.md).

### Build tooling

The library packages (`packages/core`, `packages/persistence`) build with tsdown into ESM JavaScript and declaration files in their `dist` directories, and package exports point to those files. Their third-party and `@scos/*` dependencies stay external; `packages/persistence` additionally bundles its generated Prisma client (`src/generated/prisma`, produced by the `generate` task) and keeps `pg`, `@prisma/client`, `@prisma/adapter-pg` and `@scos/core` external. Declarations are emitted by the TypeScript 7 compiler; `tsc --noEmit` remains the type checker.

The API application builds with esbuild (`apps/api/build.mjs`) into a self-contained ESM bundle, `apps/api/dist/node.js` (one file per runtime entry point in `apps/api/src/entrypoints/`), for Node.js, with AWS Lambda handlers to follow later (#14, deferred). The Cloudflare Worker, the first hosted target, is bundled by Wrangler from `src/entrypoints/worker.ts` instead. The esbuild bundle inlines the built workspace libraries and third-party runtime dependencies, so it runs without `node_modules`. Only Node.js built-ins and pg's optional native addon, `pg-native`, stay external. The API publishes no package exports or declarations.

Each package's `turbo.json` declares its build configuration (`tsdown.config.ts` or `build.mjs`), `tsconfig.json`, `package.json`, and `src` as build inputs, and builds after its workspace dependencies. Turbo treats the shared TypeScript configuration as a global dependency so compiler-policy changes invalidate affected cached tasks.

## Compose path: both databases by hand

Copy `.env.example` to `.env` for local configuration. The committed values are local-only examples and contain no external credentials.

Start both databases and wait for their health checks:

```sh
docker compose up -d --wait postgres postgres-test
```

The development database persists in the `scos-postgres-data` volume and listens on port 5432. The test database listens on port 5433 and stores its data in container-scoped temporary memory. It is separate so integration tests cannot alter development data.

Run the real-database integration harness:

```sh
DATABASE_TEST_URL=postgresql://scos_test:scos_test@localhost:5433/scos_test \
  pnpm test:integration
```

The harness creates a uniquely named schema, proves a transaction rollback leaves no rows, and drops the schema when the test completes. The persistence schema tests create a uniquely named database beside `scos_test` for each test file, apply the real migrations, and drop it afterwards. Database integration tasks are uncached.

## Database schema, migrations, and seed

The PostgreSQL schema, Prisma client, migrations, and warehouse seed live in `packages/persistence`. With `DATABASE_URL` exported:

```sh
pnpm db:migrate   # apply pending migrations
pnpm db:seed      # apply migrations, then insert missing seed warehouses
```

Seeding never replenishes consumed stock. The destructive `db:reset` requires `SCOS_CONFIRM_DATABASE_RESET` to match the target database name. See [database schema](database-schema.md) for the entity relationships and schema decisions,.

## Stopping and removing local data

Ctrl+C stops the API gracefully: it closes the listener, then its database
connections. The shared PostgreSQL container and all databases remain
available. The scripts never stop the shared container, reset databases, or
remove volumes. Worktree removal does not delete its database; keep or remove
that data separately when it is no longer needed, as below.

The shared container is used by every worktree. Before stopping it or deleting
its volume, check that no other worktree's API or tests still need it.

### This worktree's database

Stop this worktree's API first (an open connection makes `DROP DATABASE`
fail). Then, from the worktree root, compute the same name the launcher uses
and drop it:

```sh
db="scos_wt_$(node -p 'require("node:crypto").createHash("sha256").update(process.cwd()).digest("hex").slice(0, 24)')"
docker exec scos-local-postgres-1 psql -X -U scos -d postgres -c "DROP DATABASE IF EXISTS \"$db\""
```

`scos-local-postgres-1` and `scos` are the container and user when the
launcher created the container. If it reused another container, use that
container's name (or `SCOS_POSTGRES_CONTAINER`) and its `POSTGRES_USER`. The
name depends on the worktree's absolute path, so run this before moving or
removing the worktree; afterwards, list the worktree databases with
`docker exec scos-local-postgres-1 psql -X -U scos -d postgres -c '\l scos_wt_*'`
and drop the one you no longer need by name. The next
`./dev.sh` recreates an empty, migrated and seeded database.

### The shared container

If the launcher created the container, it belongs to the Compose project
`scos-local`:

```sh
docker compose --project-name scos-local -f compose.yaml down            # stop and remove; data kept
docker compose --project-name scos-local -f compose.yaml down --volumes  # also delete the data volume
```

`down` keeps the `scos-local_scos-postgres-data` volume, and the next
`./dev.sh` starts a new container over it. `down --volumes` deletes that
volume: every worktree's database, all Orders and all stock changes are lost
and cannot be recovered. If `./dev.sh` reused a container you started
yourself, manage it the way you created it.

### Compose services started by hand

Services started with `docker compose up` (see
[Compose path](#compose-path-both-databases-by-hand)) belong to a project named after the checkout directory, so run these
from the same checkout:

```sh
docker compose down             # keep the development volume
docker compose down --volumes   # delete it and all local development data
```

The test database (`postgres-test`) keeps its data in memory only and never
survives `down`. Both paths publish PostgreSQL on host port 5432, so stop one
before starting the other.
