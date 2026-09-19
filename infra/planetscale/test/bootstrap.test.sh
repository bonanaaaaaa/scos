#!/usr/bin/env bash
# Tests for infra/planetscale/bootstrap.sh with stub pscale, wrangler and gh
# executables on PATH. No network, no credentials.
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
    SECRETS_REPO="owner/repo" \
    BRANCH_READY_POLL_SECONDS=0 \
    "$@" \
    bash "$script" >"$out" 2>"$err"
  status=$?
  set -e
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
# No secret may appear in stdout or stderr, except inside an ::add-mask::
# command, which the Actions runner consumes and never displays.
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
  pass
}

# --- first run: creates the database and both roles ------------------------
new_case "first run creates everything"
run CREATE_DATABASE=true
expect_status 0
expect_calls '^pscale database create scos --engine postgresql --region ap-southeast --cluster-size PS-5 --major-version 18 --replicas 0 --cloudflare-billing @- --wait --org scos-org --format json$' 1
expect_calls '^wrangler hyperdrive planetscale signature$' 1
expect_calls '^pscale role create scos main scos_runtime --inherited-roles pg_read_all_data,pg_write_all_data ' 1
expect_calls '^pscale role create scos main scos_migrator --inherited-roles postgres ' 1
expect_calls '^gh secret set HYPERDRIVE_ORIGIN_PASSWORD --env prod --repo owner/repo$' 1
expect_calls '^gh secret set MIGRATION_DATABASE_URL --env prod --repo owner/repo$' 1
if [[ -f "$state/billing_ok" ]]; then pass; else fail "pscale did not receive the billing proof on stdin"; fi
runtime_password="$(sed -n 1p "$state/passwords")"
migration_password="$(sed -n 2p "$state/passwords")"
if [[ "$(cat "$state/secrets/HYPERDRIVE_ORIGIN_PASSWORD")" == "$runtime_password" ]]; then pass; else fail "runtime password secret mismatch"; fi
url="$(cat "$state/secrets/MIGRATION_DATABASE_URL")"
encoded="$(jq -rn --arg p "$migration_password" '$p | @uri')"
if [[ "$url" == "postgresql://scos_migrator.stubbranch:${encoded}@ap-southeast.pg.psdb.cloud:5432/postgres?sslmode=require" ]]; then pass; else fail "unexpected migration URL shape"; fi
expect_output_contains "ap-southeast.pg.psdb.cloud"
expect_output_contains "scos_runtime.stubbranch"
expect_no_secrets
if grep -rqF "$SIGNATURE" "$state/secrets"; then fail "signature reached a secret"; else pass; fi

# --- second run against the same state: zero create/reset calls -----------
case_name="second run is a no-op"
: >"$state/calls.log"
run CREATE_DATABASE=true
expect_status 0
expect_calls ' (create|reset|reset-default|delete) ' 0
expect_calls '^wrangler ' 0
expect_calls '^gh secret set' 0
expect_no_secrets

# --- secrets are masked under GitHub Actions -------------------------------
new_case "actions masking"
run CREATE_DATABASE=true GITHUB_ACTIONS=true
expect_status 0
while IFS= read -r secret; do
  if grep -qxF "::add-mask::$secret" "$err"; then pass; else fail "password not masked"; fi
done <"$state/passwords"
if grep -qxF "::add-mask::$SIGNATURE" "$err"; then pass; else fail "signature not masked"; fi
expect_no_secrets

# --- database exists (dashboard fallback): only roles are managed ----------
new_case "existing database, one role missing"
touch "$state/db"
mkdir -p "$state/roles"
touch "$state/roles/scos_runtime"
run
expect_status 0
expect_calls '^pscale database create' 0
expect_calls '^wrangler ' 0
expect_calls '^pscale role create scos main scos_runtime ' 0
expect_calls '^pscale role create scos main scos_migrator ' 1
expect_calls '^gh secret set HYPERDRIVE_ORIGIN_PASSWORD' 0
expect_calls '^gh secret set MIGRATION_DATABASE_URL' 1
expect_no_secrets

# --- missing database without CREATE_DATABASE=true -------------------------
new_case "missing database needs explicit creation"
run
expect_nonzero
expect_calls ' create ' 0
expect_output_contains "CREATE_DATABASE is false"

# --- missing organization ----------------------------------------------------
new_case "missing org"
run CREATE_DATABASE=true PLANETSCALE_ORG=
expect_nonzero
expect_output_contains "PLANETSCALE_ORG is empty"
expect_calls '^pscale ' 0

# --- pscale too old ----------------------------------------------------------
new_case "pscale below minimum"
run CREATE_DATABASE=true STUB_PSCALE_VERSION=0.312.9
expect_nonzero
expect_output_contains "0.313.0 or newer"
expect_calls ' create ' 0

# --- wrangler too old (pinned repo version lacks the signature command) ----
new_case "wrangler below minimum"
run CREATE_DATABASE=true STUB_WRANGLER_VERSION=4.124.0
expect_nonzero
expect_output_contains "4.126.0 or newer"
expect_calls ' create ' 0

# --- workspace Wrangler not installed ----------------------------------------
new_case "wrangler binary missing"
run CREATE_DATABASE=true WRANGLER_CMD=/nonexistent/wrangler
expect_nonzero
expect_output_contains "pnpm install --frozen-lockfile"
expect_calls ' create ' 0

# --- no secret sink: nothing is created ------------------------------------
new_case "roles need a secret sink"
run CREATE_DATABASE=true SECRETS_REPO=
expect_nonzero
expect_output_contains "SECRETS_REPO is empty"
expect_calls ' create ' 0

new_case "secret sink not writable"
run CREATE_DATABASE=true STUB_GH_LIST_EXIT=1
expect_nonzero
expect_calls ' create ' 0

# --- MANAGE_ROLES=false creates only the database ---------------------------
new_case "database only"
run CREATE_DATABASE=true MANAGE_ROLES=false SECRETS_REPO=
expect_status 0
expect_calls '^pscale database create' 1
expect_calls '^pscale role ' 0
expect_no_secrets

# --- billing signature for another account ---------------------------------
new_case "signature account mismatch"
run CREATE_DATABASE=true STUB_SIGNATURE_ACCOUNT=ffffffffffffffffffffffffffffffff
expect_nonzero
expect_calls '^pscale database create' 0
expect_no_secrets

# --- incomplete pscale output never becomes a "null" secret -----------------
new_case "role create without password"
run CREATE_DATABASE=true STUB_ROLE_OMIT=password
expect_nonzero
expect_calls '^gh secret set' 0
expect_output_contains "returned no password"
expect_no_secrets

new_case "role create without database_name"
run CREATE_DATABASE=true STUB_ROLE_OMIT=database_name
expect_nonzero
expect_calls '^gh secret set HYPERDRIVE_ORIGIN_PASSWORD' 1
expect_calls '^gh secret set MIGRATION_DATABASE_URL' 0
expect_output_contains "lacks username, password, access_host_url or database_name"
if grep -rq 'null' "$state/secrets" 2>/dev/null; then fail "a secret contains null"; else pass; fi
expect_no_secrets

new_case "role create without access_host_url"
run CREATE_DATABASE=true STUB_ROLE_OMIT=access_host_url
expect_nonzero
expect_calls '^gh secret set MIGRATION_DATABASE_URL' 0
expect_no_secrets

# --- deploy mode (EXPORT_GITHUB_ENV): the first run hands values to the job --
new_case "deploy first run exports values"
genv="$state/github_env"
: >"$genv"
run CREATE_DATABASE=true GITHUB_ACTIONS=true EXPORT_GITHUB_ENV=true GITHUB_ENV="$genv"
expect_status 0
runtime_password="$(sed -n 1p "$state/passwords")"
migration_url="$(cat "$state/secrets/MIGRATION_DATABASE_URL")"
if grep -qxF "BOOTSTRAP_HYPERDRIVE_ORIGIN_PASSWORD=$runtime_password" "$genv"; then pass; else fail "fresh runtime password not exported"; fi
if grep -qxF "BOOTSTRAP_MIGRATION_DATABASE_URL=$migration_url" "$genv"; then pass; else fail "fresh migration URL not exported"; fi
for line in BOOTSTRAP_PLANETSCALE_HOST=ap-southeast.pg.psdb.cloud \
  BOOTSTRAP_HYPERDRIVE_ORIGIN_USER=scos_runtime.stubbranch \
  BOOTSTRAP_HYPERDRIVE_ORIGIN_DATABASE=postgres; do
  if grep -qxF "$line" "$genv"; then pass; else fail "missing $line in GITHUB_ENV"; fi
done
# Every exported secret was masked first.
if grep -qxF "::add-mask::$runtime_password" "$err" && grep -qxF "::add-mask::$migration_url" "$err"; then pass; else fail "exported secret not masked"; fi
expect_calls '^gh variable set PLANETSCALE_HOST --env prod --repo owner/repo --body ap-southeast.pg.psdb.cloud$' 1
expect_calls '^gh variable set HYPERDRIVE_ORIGIN_USER --env prod --repo owner/repo --body scos_runtime.stubbranch$' 1
expect_calls '^gh variable set HYPERDRIVE_ORIGIN_DATABASE --env prod --repo owner/repo --body postgres$' 1
expect_no_secrets

case_name="deploy re-run exports nothing secret"
: >"$state/calls.log"
: >"$genv"
run CREATE_DATABASE=true GITHUB_ACTIONS=true EXPORT_GITHUB_ENV=true GITHUB_ENV="$genv"
expect_status 0
expect_calls ' (create|reset|reset-default|delete) ' 0
expect_calls '^wrangler ' 0
expect_calls '^gh (secret|variable) set' 0
if grep -qE '^BOOTSTRAP_(HYPERDRIVE_ORIGIN_PASSWORD|MIGRATION_DATABASE_URL)=' "$genv"; then fail "a secret was exported on a re-run"; else pass; fi
while IFS= read -r secret; do
  if grep -qF -- "$secret" "$genv"; then fail "a password reached GITHUB_ENV on a re-run"; fi
done <"$state/passwords"
pass
if grep -qxF "BOOTSTRAP_PLANETSCALE_HOST=ap-southeast.pg.psdb.cloud" "$genv" &&
  grep -qxF "BOOTSTRAP_HYPERDRIVE_ORIGIN_USER=scos_runtime.stubbranch" "$genv"; then pass; else fail "host/user not exported on a re-run"; fi
if grep -q '^BOOTSTRAP_HYPERDRIVE_ORIGIN_DATABASE=' "$genv"; then fail "database name exported without a source"; else pass; fi
expect_no_secrets

new_case "deploy without a secrets token creates nothing"
genv="$state/github_env"
: >"$genv"
run CREATE_DATABASE=true GITHUB_ACTIONS=true EXPORT_GITHUB_ENV=true GITHUB_ENV="$genv" STUB_GH_LIST_EXIT=1
expect_nonzero
expect_calls ' create ' 0
expect_calls '^wrangler hyperdrive' 0
if [[ -s "$genv" ]]; then fail "GITHUB_ENV written although nothing was created"; else pass; fi

new_case "deploy with the database but no token"
touch "$state/db"
genv="$state/github_env"
: >"$genv"
run GITHUB_ACTIONS=true EXPORT_GITHUB_ENV=true GITHUB_ENV="$genv" SECRETS_REPO=
expect_nonzero
expect_calls ' create ' 0
expect_output_contains "SECRETS_REPO is empty"

new_case "export mode needs Actions"
run CREATE_DATABASE=true EXPORT_GITHUB_ENV=true
expect_nonzero
expect_calls '^pscale ' 0

new_case "an operator-set variable is kept"
mkdir -p "$state/variables"
printf 'custom.example' >"$state/variables/PLANETSCALE_HOST"
run CREATE_DATABASE=true
expect_status 0
expect_calls '^gh variable set PLANETSCALE_HOST' 0
if [[ "$(cat "$state/variables/PLANETSCALE_HOST")" == custom.example ]]; then pass; else fail "operator variable overwritten"; fi
expect_output_contains "kept 'custom.example'"

# --- dry run changes nothing -------------------------------------------------
new_case "dry run"
run CREATE_DATABASE=true DRY_RUN=true
expect_status 0
expect_calls ' create ' 0
expect_output_contains "Plan: database=create, runtime role=create, migration role=create."

printf '%d passed, %d failed\n' "$passes" "$failures"
[[ "$failures" -eq 0 ]]
