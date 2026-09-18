# SCOS Ordering

Backend workspace for ordering SCOS Station P1 Pro devices. This foundation contains package boundaries, a minimal Hono application, pinned TypeScript tooling, isolated local PostgreSQL services, and the Ordering database schema with its warehouse seed. Ordering endpoints are added in later issues.

## Prerequisites

- Node.js 24.15.0 (also pinned in `.node-version` and `.nvmrc`)
- Corepack
- Docker with Compose

The repository pins pnpm 12.4.2 through `packageManager`. Run pnpm through Corepack so the pinned version is used.

## Quick local development

```sh
./setup.sh
./dev.sh
```

Setup installs locked dependencies and preserves existing `.env` configuration.
Development startup reuses or starts shared PostgreSQL, creates a separate
worktree database, and finds an available API port starting at 3000. See
[local development](docs/local-development.md) for container selection and
configuration. Ctrl+C stops the API while preserving the shared database.

## Install and verify

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm exec tsc --version
corepack pnpm build
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm format:check
corepack pnpm test
```

The compiler command must report `Version 7.0.2`. The separate quality commands build every package, type-check, lint with Oxlint, check formatting with Oxfmt, and run the current Vitest suites through Turbo. Each unit suite enforces at least 80% statement, branch, function, and line coverage. Coverage summaries are written to `coverage/` at the repository root and in each tested package.

The workspace contains:

- `packages/core`: framework-independent business core; ordering rules, use cases, and ports belong here
- `packages/persistence`: outbound database adapter boundary, depending inward on core
- `apps/api`: composition root, depending on core and persistence
- `libs/typescript-config`: shared TypeScript compiler policy consumed through the `@scos/typescript-config` workspace package

Application and adapter package exports point to compiled files in each package's `dist` directory. Turbo treats the shared TypeScript configuration as a global dependency so compiler-policy changes invalidate affected cached tasks.

## Local API

Start the API in watch mode during development. Turbo builds its workspace dependencies first:

```sh
corepack pnpm api:dev
```

The server listens on port 3000 by default. Set `PORT` to use a different port:

```sh
PORT=8080 corepack pnpm api:dev
```

For a production-style local start, Turbo builds the API and its workspace dependencies before running the compiled server:

```sh
PORT=8080 corepack pnpm api:start
```

Check application liveness with `curl http://localhost:8080/health`. The endpoint returns HTTP 200 with `{"status":"ok"}` and does not require PostgreSQL to be running.

## Local PostgreSQL

Copy `.env.example` to `.env` for local configuration. The committed values are local-only examples and contain no external credentials.

Start both databases and wait for their health checks:

```sh
docker compose up -d --wait postgres postgres-test
```

The development database persists in the `scos-postgres-data` volume and listens on port 5432. The test database listens on port 5433 and stores its data in container-scoped temporary memory. It is separate so integration tests cannot alter development data.

Run the real-database integration harness:

```sh
DATABASE_TEST_URL=postgresql://scos_test:scos_test@localhost:5433/scos_test \
  corepack pnpm test:integration
```

The harness creates a uniquely named schema, proves a transaction rollback leaves no rows, and drops the schema when the test completes. The persistence schema tests create a uniquely named database beside `scos_test` for each test file, apply the real migrations, and drop it afterwards. Database integration tasks are uncached.

Stop the services when finished:

```sh
docker compose down
```

To deliberately remove the persistent development database as well, run `docker compose down --volumes`. This deletes local development data.

## Database schema, migrations, and seed

The PostgreSQL schema, Prisma client, migrations, and warehouse seed live in `packages/persistence`. With `DATABASE_URL` exported:

```sh
corepack pnpm db:migrate   # apply pending migrations
corepack pnpm db:seed      # apply migrations, then insert missing seed warehouses
```

Seeding never replenishes consumed stock. The destructive `db:reset` requires `SCOS_CONFIRM_DATABASE_RESET` to match the target database name. See [database schema](docs/database-schema.md) for the entity relationships and schema decisions, and [local development](docs/local-development.md) for command details.

## Continuous integration

The `CI` workflow runs for pull requests targeting `main` and pushes to `main`. The pull-request policy workflows run only against `main`. Validation jobs have read-only repository access, cancel superseded pull-request runs, have bounded timeouts, and do not deploy.

The workflow exposes these stable check names:

- `Workspace checks`: frozen install followed by separate Turbo build, typecheck, Oxlint, Oxfmt, and test steps
- `Coverage comment`: aggregate Vitest coverage reporting on same-repository pull requests
- `PostgreSQL integration`: a disposable PostgreSQL 18 service and the uncached Turbo `test:integration` connectivity smoke test plus migration, schema, and seed integration tests
- `PR title`: Conventional Commit title validation on opened, edited, reopened, and synchronized pull requests
- `Code scanner`: verified-secret scanning across the pull request's explicit base and head revisions
- `Actionlint`: workflow validation when `.github/workflows/**` or `.github/actions/**` changes; local-action changes trigger the workflow but actionlint validates workflow files

The title and code-scanner checks use local composite actions copied from the repository-management baseline. The title composite passes untrusted title text through an environment variable to the repository's tested Node validator; it never interpolates the title into a shell command. The scanner checks full history with TruffleHog's verified-secret mode and converts scanner failure into a failed check.

The workspace job uploads the root, API, core, and persistence JSON coverage summaries even when a coverage threshold rejects the test step. A separate same-repository pull-request job receives only `pull-requests: write` permission to create or update the aggregate coverage comment. Fork pull requests skip that comment job and receive no write permission.

The workspace and PostgreSQL jobs use the repository's `TURBO_API` and `TURBO_TEAM` variables with the `TURBO_TOKEN` and `TURBO_REMOTE_CACHE_SIGNATURE_KEY` secrets for signed remote caching. Pull requests without those secrets, including forks, continue with Turbo's local cache. Database integration remains uncached. Cache configuration is consumed by Turbo itself and is not passed through to application tasks.

The database client gives connection and query operations five-second timeouts, while the integration test and Actions job have broader bounded timeouts. An unavailable database therefore fails the existing integration harness clearly instead of hanging or being skipped.

Pull request titles must use one of these forms:

```text
type: description
type(scope): description
type(scope)!: description
```

Allowed types are `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, and `revert`. The scope is optional but cannot be empty; `!` marks a breaking change. The description must be nonempty and remain on one line. Examples include `feat(api): add order verification`, `fix: prevent duplicate orders`, and `feat(api)!: change submission contract`.

Changing a pull request title reruns the title check without requiring a code push. Intermediate commit messages are not validated by this rule. Branch protection and repository rules remain repository settings outside this scaffold.
