# Continuous integration

How the repository validates a change. The deployment side — Terraform, the
PlanetScale bootstrap and the `Deploy Prod` pipeline — is in
[deployment pipeline](deployment-pipeline.md).

The `CI` workflow runs for pull requests targeting `main` and pushes to `main`. The pull-request policy workflows run only against `main`. Validation jobs have read-only repository access, cancel superseded pull-request runs, have bounded timeouts, and do not deploy.

The workflow exposes these stable check names:

- `Workspace checks`: frozen install followed by separate Turbo build, typecheck, Oxlint, Oxfmt, and test steps
- `Coverage comment`: aggregate Vitest coverage reporting on same-repository pull requests
- `PostgreSQL integration`: a disposable PostgreSQL 18 service and these steps:
  - a guard that fails if any test under `apps/api/test` or `packages/persistence/test` uses `.skip`, `.skipIf`, `.runIf`, `.todo` or `.only`, and a matching guard in the Acceptance workflow over `apps/api-acceptance/test` that also rejects Playwright's `.fixme` and `.fail`;
  - the uncached Turbo `test:integration` task, which builds first and then runs the persistence integration tests in `packages/persistence` (connectivity, migrations, schema, seed, inventory reader), the full-stack ordering tests through the composed API in `apps/api`, and the Worker suite in workerd against the same database;
  - the separate **Acceptance** workflow, which runs the QA acceptance suite in `apps/api-acceptance` on Playwright (`test:acceptance`) against the built API served as a real process, including the OpenAPI conformance tests: the served document is a valid OpenAPI 3.1 document, real responses conform to its schemas, and `dist/openapi.json` equals the served `/openapi.json`. It uploads a JUnit and HTML report;
  - a check that the build generated `apps/api/dist/openapi.json` and that it is not tracked by Git (the specification is generated, never committed), and an upload of it as the `openapi-specification` artifact, kept for 7 days
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
