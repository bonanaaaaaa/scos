# SCOS Ordering

Backend workspace for ordering SCOS Station P1 Pro devices. This foundation contains package boundaries, pinned TypeScript tooling, and isolated local PostgreSQL services. Business endpoints and the production schema are added in later issues.

## Prerequisites

- Node.js 24.15.0 (also pinned in `.node-version` and `.nvmrc`)
- Corepack
- Docker with Compose

The repository pins pnpm 12.4.2 through `packageManager`. Run pnpm through Corepack so the pinned version is used.

## Install and verify

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm exec tsc --version
corepack pnpm check
```

The compiler command must report `Version 7.0.2`. `check` builds every package, type-checks, lints with Oxlint, checks formatting with Oxfmt, and runs the current package boundary and configuration tests.

The workspace contains:

- `packages/ordering`: dependency-free domain/application boundary
- `packages/persistence`: outbound database adapter boundary, depending inward on ordering
- `apps/api`: composition root, depending on ordering and persistence

Package exports point to compiled files in each package's `dist` directory.

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

The harness creates a uniquely named schema, proves a transaction rollback leaves no rows, and drops the schema when the test completes. Database integration tasks are uncached.

Stop the services when finished:

```sh
docker compose down
```

To deliberately remove the persistent development database as well, run `docker compose down --volumes`. This deletes local development data.

No application server or database migration command exists yet; this issue intentionally establishes the workspace and test foundation only.
