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

`docs/openapi.json` is generated from the API's route contracts. Regenerate it
after changing a contract, schema or example, and commit the result; neither
command needs a running server or a database:

```sh
pnpm openapi:export   # write docs/openapi.json
pnpm openapi:check    # fail if docs/openapi.json is out of date
```

`pnpm test` also fails when the committed file is out of date.

Ctrl+C stops the API gracefully: it closes the listener, then its database
connections. The shared PostgreSQL container and all databases remain
available. The scripts never stop the shared container, reset databases, or
remove volumes. Worktree
removal does not delete its database; keep or remove that data separately when
it is no longer needed.
