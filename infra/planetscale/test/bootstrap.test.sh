#!/usr/bin/env bash
# Tests for infra/planetscale/bootstrap.sh with stub pscale and wrangler
# executables on PATH (and a gh tripwire: the script must never call it). No
# network, no credentials.
#
# Run: bash infra/planetscale/test/bootstrap.test.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/../bootstrap.sh"
stubs="$here/stubs"
work="$(mktemp -d "${TMPDIR:-/tmp}/scos-pscale-test.XXXXXX")"
trap 'rm -rf "$work"' EXIT

readonly SIGNATURE="SIGNATURE-SECRET-5f2a9c"
readonly ACCOUNT="0123456789abcdef0123456789abcdef"
failures=0
passes=0
case_name=""
state=""
out=""
err=""
status=0

command -v jq >/dev/null || {
  echo "jq is required" >&2
  exit 1
}

new_case() {
  case_name="$1"
  state="$work/$(printf '%s' "$case_name" | tr -c 'a-zA-Z0-9' '_')"
  mkdir -p "$state"
  out="$state/stdout"
  err="$state/stderr"
}

# run [VAR=value ...]: runs the bootstrap with a clean environment plus the
# given variables. Sets $status.
run() {
  set +e
  env -i \
    PATH="$stubs:/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$(command -v jq)")" \
    HOME="$state" \
    STUB_STATE="$state" \
    STUB_SIGNATURE="$SIGNATURE" \
    PLANETSCALE_ORG="scos-org" \
    PLANETSCALE_SERVICE_TOKEN_ID="token-id" \
    PLANETSCALE_SERVICE_TOKEN="service-token-secret" \
    CLOUDFLARE_ACCOUNT_ID="$ACCOUNT" \
    CLOUDFLARE_API_TOKEN="cloudflare-token-secret" \
    WRANGLER_CMD="wrangler" \
    BRANCH_READY_POLL_SECONDS=0 \
    "$@" \
    bash "$script" >"$out" 2>"$err"
  status=$?
  set -e
}

# run_deploy [VAR=value ...]: as the deploy runs it, exporting to a
# $GITHUB_ENV file at $genv (emptied first).
run_deploy() {
  genv="$state/github_env"
  : >"$genv"
  run GITHUB_ACTIONS=true EXPORT_GITHUB_ENV=true GITHUB_ENV="$genv" "$@"
}

pass() { passes=$((passes + 1)); }
fail() {
  failures=$((failures + 1))
  printf 'FAIL [%s]: %s\n' "$case_name" "$1" >&2
  printf '  stdout:\n%s\n  stderr:\n%s\n' "$(sed 's/^/    /' "$out")" "$(sed 's/^/    /' "$err")" >&2
}

expect_status() {
  if [[ "$status" -eq "$1" ]]; then pass; else fail "expected exit $1, got $status"; fi
}
expect_nonzero() {
  if [[ "$status" -ne 0 ]]; then pass; else fail "expected a non-zero exit"; fi
}
calls_matching() { grep -cE "$1" "$state/calls.log" 2>/dev/null || true; }
expect_calls() {
  local n
  n="$(calls_matching "$1")"
  if [[ "$n" -eq "$2" ]]; then pass; else fail "expected $2 call(s) matching '$1', got $n"; fi
}
expect_output_contains() {
  if grep -qF -- "$1" "$out" "$err"; then pass; else fail "output lacks '$1'"; fi
}
genv_has() { grep -qxF -- "$1" "$genv"; }
expect_genv() {
  if genv_has "$1"; then pass; else fail "GITHUB_ENV lacks '$1'"; fi
}
# No secret credential line in $GITHUB_ENV.
expect_no_secret_export() {
  if grep -qE '^BOOTSTRAP_(PLANETSCALE_RUNTIME_PASSWORD|MIGRATION_DATABASE_URL)=' "$genv"; then
    fail "a credential was exported"
  else
    pass
  fi
}
# The script never calls gh (no GitHub secret or variable is written).
expect_no_gh() { expect_calls '^gh ' 0; }
last_password() { tail -n 1 "$state/passwords"; }
migration_url_for() {
  local encoded
  encoded="$(jq -rn --arg p "$1" '$p | @uri')"
  printf 'postgresql://scos_migrator.stubbranch:%s@ap-southeast.pg.psdb.cloud:5432/postgres?sslmode=require' "$encoded"
}

# No secret may appear in stdout or stderr, except inside an ::add-mask::
# command, which the Actions runner consumes and never displays. The
# $GITHUB_ENV file may hold the fresh credentials (that is its job), but
# never the billing signature or a token.
expect_no_secrets() {
  local secret
  local -a secrets=("$SIGNATURE" "service-token-secret" "cloudflare-token-secret")
  if [[ -f "$state/passwords" ]]; then
    while IFS= read -r secret; do secrets+=("$secret"); done <"$state/passwords"
  fi
  for secret in "${secrets[@]}"; do
    if grep -v '^::add-mask::' "$out" "$err" | grep -qF -- "$secret"; then
      fail "secret '$secret' leaked into output"
      return
    fi
  done
  if [[ -n "${genv:-}" && -f "$genv" ]] &&
    grep -qF -e "$SIGNATURE" -e "service-token-secret" -e "cloudflare-token-secret" "$genv"; then
    fail "a token or the signature reached GITHUB_ENV"
    return
  fi
  pass
}

# --- deploy first run: creates the database and both roles, exports once --
new_case "deploy first run creates everything"
run_deploy CREATE_DATABASE=true
expect_status 0
expect_calls '^pscale database create scos --engine postgresql --region ap-southeast --cluster-size PS-5 --major-version 18 --replicas 0 --cloudflare-billing @- --wait --org scos-org --format json$' 1
expect_calls '^wrangler hyperdrive planetscale signature$' 1
expect_calls '^pscale role create scos main scos_runtime --inherited-roles pg_read_all_data,pg_write_all_data ' 1
expect_calls '^pscale role create scos main scos_migrator --inherited-roles postgres ' 1
expect_no_gh
if [[ -f "$state/billing_ok" ]]; then pass; else fail "pscale did not receive the billing proof on stdin"; fi
runtime_password="$(sed -n 1p "$state/passwords")"
migration_password="$(sed -n 2p "$state/passwords")"
migration_url="$(migration_url_for "$migration_password")"
expect_genv "BOOTSTRAP_PLANETSCALE_RUNTIME_PASSWORD=$runtime_password"
expect_genv "BOOTSTRAP_MIGRATION_DATABASE_URL=$migration_url"
expect_genv "BOOTSTRAP_PLANETSCALE_HOST=ap-southeast.pg.psdb.cloud"
expect_genv "BOOTSTRAP_HYPERDRIVE_ORIGIN_USER=scos_runtime.stubbranch"
expect_genv "BOOTSTRAP_HYPERDRIVE_ORIGIN_DATABASE=postgres"
# Every exported secret was masked, and so was the signature.
for secret in "$runtime_password" "$migration_url" "$SIGNATURE"; do
  if grep -qxF "::add-mask::$secret" "$err"; then pass; else fail "a secret was not masked"; fi
done
expect_output_contains "ap-southeast.pg.psdb.cloud"
expect_output_contains "scos_runtime.stubbranch"
expect_no_secrets

# --- re-run against the same state: nothing created, no credential exported --
case_name="deploy re-run is a no-op"
: >"$state/calls.log"
run_deploy CREATE_DATABASE=true
expect_status 0
expect_calls ' (create|reset|reset-default|delete) ' 0
expect_calls '^wrangler ' 0
expect_no_gh
expect_no_secret_export
while IFS= read -r secret; do
  if grep -qF -- "$secret" "$genv"; then fail "a password reached GITHUB_ENV on a re-run"; fi
done <"$state/passwords"
pass
# The non-secret values are read from PlanetScale on every run.
expect_genv "BOOTSTRAP_PLANETSCALE_HOST=ap-southeast.pg.psdb.cloud"
expect_genv "BOOTSTRAP_HYPERDRIVE_ORIGIN_USER=scos_runtime.stubbranch"
if grep -q '^BOOTSTRAP_HYPERDRIVE_ORIGIN_DATABASE=' "$genv"; then fail "database name exported without a source"; else pass; fi
expect_no_secrets

# --- rotation: resets only the named role and exports its new credential ----
case_name="rotate the runtime role"
: >"$state/calls.log"
run_deploy ROTATE_ROLES=runtime
expect_status 0
expect_calls '^pscale role reset scos main id-scos_runtime --force ' 1
expect_calls '^pscale role reset scos main id-scos_migrator ' 0
expect_calls ' create ' 0
expect_no_gh
new_runtime="$(last_password)"
if [[ "$new_runtime" != "$runtime_password" ]]; then pass; else fail "the runtime password did not change"; fi
expect_genv "BOOTSTRAP_PLANETSCALE_RUNTIME_PASSWORD=$new_runtime"
if grep -q '^BOOTSTRAP_MIGRATION_DATABASE_URL=' "$genv"; then fail "the migration URL was exported without rotation"; else pass; fi
if grep -qxF "::add-mask::$new_runtime" "$err"; then pass; else fail "new runtime password not masked"; fi
expect_no_secrets

case_name="rotate both roles"
: >"$state/calls.log"
run_deploy ROTATE_ROLES=both
expect_status 0
expect_calls '^pscale role reset ' 2
new_runtime="$(tail -n 2 "$state/passwords" | head -n 1)"
new_migration="$(last_password)"
expect_genv "BOOTSTRAP_PLANETSCALE_RUNTIME_PASSWORD=$new_runtime"
expect_genv "BOOTSTRAP_MIGRATION_DATABASE_URL=$(migration_url_for "$new_migration")"
expect_genv "BOOTSTRAP_HYPERDRIVE_ORIGIN_DATABASE=postgres"
expect_no_gh
expect_no_secrets

new_case "rotating a missing role creates it"
touch "$state/db"
run_deploy ROTATE_ROLES=runtime
expect_status 0
expect_calls '^pscale role reset ' 0
expect_calls '^pscale role create ' 2
expect_no_secrets

new_case "reset without a password exports nothing"
touch "$state/db"
mkdir -p "$state/roles"
touch "$state/roles/scos_runtime" "$state/roles/scos_migrator"
run_deploy ROTATE_ROLES=runtime STUB_RESET_OMIT=password
expect_nonzero
expect_output_contains "returned no password"
expect_no_secret_export
expect_no_secrets

new_case "reset uses the configured database name"
touch "$state/db"
mkdir -p "$state/roles"
touch "$state/roles/scos_runtime" "$state/roles/scos_migrator"
run_deploy ROTATE_ROLES=migration ORIGIN_DATABASE_FALLBACK=appdb
expect_status 0
encoded="$(jq -rn --arg p "$(last_password)" '$p | @uri')"
expect_genv "BOOTSTRAP_MIGRATION_DATABASE_URL=postgresql://scos_migrator.stubbranch:${encoded}@ap-southeast.pg.psdb.cloud:5432/appdb?sslmode=require"
if grep -q null "$genv"; then fail "GITHUB_ENV contains null"; else pass; fi
expect_no_secrets

new_case "reset without database_name defaults to postgres"
touch "$state/db"
mkdir -p "$state/roles"
touch "$state/roles/scos_runtime" "$state/roles/scos_migrator"
run_deploy ROTATE_ROLES=migration STUB_RESET_OMIT=database_name
expect_status 0
expect_genv "BOOTSTRAP_MIGRATION_DATABASE_URL=$(migration_url_for "$(last_password)")"
expect_no_secrets

new_case "an unsafe database fallback is refused"
run_deploy ORIGIN_DATABASE_FALLBACK='db;x'
expect_nonzero
expect_calls '^pscale ' 0

# --- outside the deploy, roles are never created or reset --------------------
new_case "a local run does not create roles"
run CREATE_DATABASE=true
expect_nonzero
expect_output_contains "Roles are created and rotated only by the deploy"
expect_calls ' create ' 0
expect_calls '^wrangler hyperdrive' 0
expect_no_gh

new_case "a local run does not rotate"
touch "$state/db"
mkdir -p "$state/roles"
touch "$state/roles/scos_runtime" "$state/roles/scos_migrator"
run ROTATE_ROLES=both
expect_nonzero
expect_calls '^pscale role reset' 0
expect_output_contains "Roles are created and rotated only by the deploy"

new_case "a local run with the roles present changes nothing"
touch "$state/db"
mkdir -p "$state/roles"
touch "$state/roles/scos_runtime" "$state/roles/scos_migrator"
run
expect_status 0
expect_calls ' (create|reset) ' 0
expect_no_gh
expect_output_contains "ap-southeast.pg.psdb.cloud"

new_case "database only (manual repair)"
run CREATE_DATABASE=true MANAGE_ROLES=false
expect_status 0
expect_calls '^pscale database create' 1
expect_calls '^pscale role ' 0
expect_no_gh
expect_no_secrets

new_case "rotation needs MANAGE_ROLES"
run_deploy ROTATE_ROLES=runtime MANAGE_ROLES=false
expect_nonzero
expect_calls '^pscale ' 0

new_case "unknown ROTATE_ROLES value"
run_deploy ROTATE_ROLES=all
expect_nonzero
expect_output_contains "ROTATE_ROLES must be none, runtime, migration or both"
expect_calls '^pscale ' 0

# --- database exists (dashboard fallback): only the missing role -------------
new_case "existing database, one role missing"
touch "$state/db"
mkdir -p "$state/roles"
touch "$state/roles/scos_runtime"
run_deploy
expect_status 0
expect_calls '^pscale database create' 0
expect_calls '^wrangler ' 0
expect_calls '^pscale role create scos main scos_runtime ' 0
expect_calls '^pscale role create scos main scos_migrator ' 1
if grep -q '^BOOTSTRAP_PLANETSCALE_RUNTIME_PASSWORD=' "$genv"; then fail "runtime password exported for an existing role"; else pass; fi
expect_genv "BOOTSTRAP_MIGRATION_DATABASE_URL=$(migration_url_for "$(last_password)")"
expect_no_secrets

# --- preconditions ------------------------------------------------------------
new_case "missing database needs explicit creation"
run_deploy
expect_nonzero
expect_calls ' create ' 0
expect_output_contains "CREATE_DATABASE is false"

new_case "missing org"
run_deploy CREATE_DATABASE=true PLANETSCALE_ORG=
expect_nonzero
expect_output_contains "PLANETSCALE_ORG is empty"
expect_calls '^pscale ' 0

new_case "pscale below minimum"
run_deploy CREATE_DATABASE=true STUB_PSCALE_VERSION=0.312.9
expect_nonzero
expect_output_contains "0.313.0 or newer"
expect_calls ' create ' 0

new_case "wrangler below minimum"
run_deploy CREATE_DATABASE=true STUB_WRANGLER_VERSION=4.124.0
expect_nonzero
expect_output_contains "4.126.0 or newer"
expect_calls ' create ' 0

new_case "signature failure shows Wrangler's error"
run_deploy CREATE_DATABASE=true STUB_WRANGLER_SIGNATURE_ERROR="Authentication failed (status: 400) [code: 9106]"
expect_nonzero
expect_output_contains "Authentication failed (status: 400) [code: 9106]"
expect_output_contains "lacks a permission"
expect_calls ' create ' 0
expect_no_secrets

new_case "wrangler binary missing"
run_deploy CREATE_DATABASE=true WRANGLER_CMD=/nonexistent/wrangler
expect_nonzero
expect_output_contains "pnpm install --frozen-lockfile"
expect_calls ' create ' 0

new_case "signature account mismatch"
run_deploy CREATE_DATABASE=true STUB_SIGNATURE_ACCOUNT=ffffffffffffffffffffffffffffffff
expect_nonzero
expect_calls '^pscale database create' 0
expect_no_secret_export
expect_no_secrets

new_case "export mode needs Actions"
run CREATE_DATABASE=true EXPORT_GITHUB_ENV=true
expect_nonzero
expect_calls '^pscale ' 0

# --- incomplete pscale output never becomes a "null" credential --------------
new_case "role create without password"
run_deploy CREATE_DATABASE=true STUB_ROLE_OMIT=password
expect_nonzero
expect_output_contains "returned no password"
expect_no_secret_export
expect_no_secrets

new_case "role create uses the configured database name (pscale reports none)"
run_deploy CREATE_DATABASE=true ORIGIN_DATABASE_FALLBACK=appdb
expect_status 0
encoded="$(jq -rn --arg p "$(last_password)" '$p | @uri')"
expect_genv "BOOTSTRAP_MIGRATION_DATABASE_URL=postgresql://scos_migrator.stubbranch:${encoded}@ap-southeast.pg.psdb.cloud:5432/appdb?sslmode=require"
if grep -q null "$genv"; then fail "GITHUB_ENV contains null"; else pass; fi
expect_no_secrets

new_case "role create with host:port 5432"
run_deploy CREATE_DATABASE=true STUB_HOST_PORT=5432
expect_status 0
expect_genv "BOOTSTRAP_PLANETSCALE_HOST=ap-southeast.pg.psdb.cloud"
encoded="$(jq -rn --arg p "$(last_password)" '$p | @uri')"
expect_genv "BOOTSTRAP_MIGRATION_DATABASE_URL=postgresql://scos_migrator.stubbranch:${encoded}@ap-southeast.pg.psdb.cloud:5432/postgres?sslmode=require"
expect_no_secrets

new_case "existing roles listed with host:5432"
touch "$state/db"
mkdir -p "$state/roles"
touch "$state/roles/scos_runtime" "$state/roles/scos_migrator"
run_deploy STUB_HOST_PORT=5432
expect_status 0
expect_genv "BOOTSTRAP_PLANETSCALE_HOST=ap-southeast.pg.psdb.cloud"
expect_no_secret_export

new_case "role create with another port"
run_deploy CREATE_DATABASE=true STUB_HOST_PORT=6432
expect_nonzero
expect_output_contains "reports port 6432"
if grep -q '^BOOTSTRAP_PLANETSCALE_RUNTIME_PASSWORD=' "$genv"; then fail "a credential was exported"; else pass; fi
expect_no_secrets

new_case "role create without access_host_url"
run_deploy CREATE_DATABASE=true STUB_ROLE_OMIT=access_host_url
expect_nonzero
if grep -q '^BOOTSTRAP_MIGRATION_DATABASE_URL=' "$genv"; then fail "a migration URL was exported"; else pass; fi
expect_no_secrets

# --- dry runs change nothing -------------------------------------------------
new_case "dry run"
run CREATE_DATABASE=true DRY_RUN=true
expect_status 0
expect_calls ' create ' 0
expect_output_contains "Plan: database=create, runtime role=create, migration role=create."

new_case "dry run of a rotation"
touch "$state/db"
mkdir -p "$state/roles"
touch "$state/roles/scos_runtime" "$state/roles/scos_migrator"
run_deploy DRY_RUN=true ROTATE_ROLES=both
expect_status 0
expect_calls '^pscale role reset' 0
expect_output_contains "Plan: database=keep, runtime role=reset, migration role=reset."
expect_no_secret_export

printf '%d passed, %d failed\n' "$passes" "$failures"
[[ "$failures" -eq 0 ]]
