#!/usr/bin/env bash
# Idempotent PlanetScale Postgres bootstrap for SCOS (issue #15).
#
# Creates, only when missing:
#   1. the PlanetScale Postgres database, billed through the Cloudflare account
#      (`wrangler hyperdrive planetscale signature | pscale database create ...`);
#   2. the runtime role used by Hyperdrive (pg_read_all_data,pg_write_all_data);
#   3. the migration role used by `prisma migrate deploy` and the seed job.
#
# Anything that already exists is left alone: no database is recreated and no
# role password is reset. Rotation is a separate, manual action (see
# docs/planetscale-bootstrap.md).
#
# Secrets (the billing signature and the role passwords) are held in memory
# only. They are never printed, never written to a file and never passed as a
# command-line argument. A new role's password goes straight into GitHub
# environment secrets through `gh secret set` (stdin), so a role is created
# only when that sink is configured.
#
# Inputs are environment variables; see docs/planetscale-bootstrap.md.

set -euo pipefail

readonly PSCALE_MIN_VERSION="0.313.0"
# `wrangler hyperdrive planetscale signature` first shipped in Wrangler 4.126.0.
readonly WRANGLER_MIN_VERSION="4.126.0"
readonly WRANGLER_DEFAULT_VERSION="4.135.0"

PLANETSCALE_ORG="${PLANETSCALE_ORG:-}"
PLANETSCALE_DATABASE="${PLANETSCALE_DATABASE:-scos}"
PLANETSCALE_BRANCH="${PLANETSCALE_BRANCH:-main}"
PLANETSCALE_REGION="${PLANETSCALE_REGION:-ap-southeast}"
PLANETSCALE_CLUSTER_SIZE="${PLANETSCALE_CLUSTER_SIZE:-PS-5}"
PLANETSCALE_POSTGRES_MAJOR_VERSION="${PLANETSCALE_POSTGRES_MAJOR_VERSION:-18}"
PLANETSCALE_REPLICAS="${PLANETSCALE_REPLICAS:-0}"
RUNTIME_ROLE_NAME="${RUNTIME_ROLE_NAME:-scos_runtime}"
RUNTIME_INHERITED_ROLES="${RUNTIME_INHERITED_ROLES:-pg_read_all_data,pg_write_all_data}"
MIGRATION_ROLE_NAME="${MIGRATION_ROLE_NAME:-scos_migrator}"
MIGRATION_INHERITED_ROLES="${MIGRATION_INHERITED_ROLES:-postgres}"
CREATE_DATABASE="${CREATE_DATABASE:-false}"
MANAGE_ROLES="${MANAGE_ROLES:-true}"
DRY_RUN="${DRY_RUN:-false}"
SECRETS_REPO="${SECRETS_REPO:-}"
SECRETS_ENVIRONMENT="${SECRETS_ENVIRONMENT:-prod}"
WRANGLER_VERSION="${WRANGLER_VERSION:-$WRANGLER_DEFAULT_VERSION}"
WRANGLER_CMD="${WRANGLER_CMD:-}"
BRANCH_READY_TIMEOUT_SECONDS="${BRANCH_READY_TIMEOUT_SECONDS:-900}"
BRANCH_READY_POLL_SECONDS="${BRANCH_READY_POLL_SECONDS:-15}"

log() { printf '%s\n' "$*" >&2; }
die() {
  if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    printf '::error::%s\n' "$*" >&2
  else
    printf 'error: %s\n' "$*" >&2
  fi
  exit 1
}

# Registers a value with the Actions runner so it is redacted from every later
# log line. Outside Actions this is a no-op: nothing prints the value anyway.
# Written to stderr: the runner reads workflow commands from both streams, and
# stdout is captured by command substitutions in this script.
mask() {
  if [[ "${GITHUB_ACTIONS:-}" == "true" && -n "$1" ]]; then
    printf '::add-mask::%s\n' "$1" >&2
  fi
}

is_true() { [[ "$1" == "true" ]]; }

# version_ge A B: true when dotted version A >= B.
version_ge() {
  local -a a b
  local i x y
  IFS=. read -r -a a <<<"$1"
  IFS=. read -r -a b <<<"$2"
  for i in 0 1 2; do
    x="${a[i]:-0}"
    y="${b[i]:-0}"
    if ((10#$x > 10#$y)); then return 0; fi
    if ((10#$x < 10#$y)); then return 1; fi
  done
  return 0
}

first_version() { grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1; }

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required but not found on PATH."
}

wrangler_run() {
  if [[ -n "$WRANGLER_CMD" ]]; then
    "$WRANGLER_CMD" "$@"
  else
    npx --yes "wrangler@${WRANGLER_VERSION}" "$@"
  fi
}

# Runs pscale with JSON output. Prints stdout; returns pscale's exit status.
# pscale reads PLANETSCALE_SERVICE_TOKEN_ID and PLANETSCALE_SERVICE_TOKEN from
# the environment, so the token never appears in process arguments.
ps_json() {
  pscale "$@" --org "$PLANETSCALE_ORG" --format json
}

# jq helper: require("field") yields a non-empty string field or raises an
# error naming only the field. Used so a missing field can never become the
# literal string "null" in a stored secret.
# shellcheck disable=SC2016 # jq variables, not shell expansions.
readonly JQ_REQUIRE='def require($k): if (.[$k] | type) == "string" and (.[$k] | length) > 0 then .[$k] else error("missing field \($k)") end;'
readonly JQ_MIGRATION_URL=' "postgresql://\(require("username") | @uri):\(require("password") | @uri)@\(require("access_host_url")):5432/\(require("database_name"))?sslmode=require"'

json_error() { jq -r '.error // "unknown error"' <<<"$1" 2>/dev/null || printf 'unparseable output\n'; }
json_issue_code() { jq -r '.issues[0].code // empty' <<<"$1" 2>/dev/null || true; }

validate_inputs() {
  [[ -n "$PLANETSCALE_ORG" ]] || die "PLANETSCALE_ORG is empty. Set the PLANETSCALE_ORG repository variable (or export it locally)."
  if [[ -n "${PLANETSCALE_SERVICE_TOKEN_ID:-}" && -z "${PLANETSCALE_SERVICE_TOKEN:-}" ]] ||
    [[ -z "${PLANETSCALE_SERVICE_TOKEN_ID:-}" && -n "${PLANETSCALE_SERVICE_TOKEN:-}" ]]; then
    die "Set both PLANETSCALE_SERVICE_TOKEN_ID and PLANETSCALE_SERVICE_TOKEN, or neither (local pscale auth login)."
  fi
  if [[ "${GITHUB_ACTIONS:-}" == "true" && -z "${PLANETSCALE_SERVICE_TOKEN:-}" ]]; then
    die "PLANETSCALE_SERVICE_TOKEN_ID and PLANETSCALE_SERVICE_TOKEN are required in GitHub Actions."
  fi
  local name value
  for name in CREATE_DATABASE MANAGE_ROLES DRY_RUN; do
    value="${!name}"
    [[ "$value" == "true" || "$value" == "false" ]] || die "$name must be true or false, got '$value'."
  done
  for name in PLANETSCALE_DATABASE PLANETSCALE_BRANCH RUNTIME_ROLE_NAME MIGRATION_ROLE_NAME; do
    value="${!name}"
    [[ "$value" =~ ^[a-z][a-z0-9_-]*$ ]] || die "$name must match ^[a-z][a-z0-9_-]*\$, got '$value'."
  done
  [[ "$RUNTIME_ROLE_NAME" != "$MIGRATION_ROLE_NAME" ]] || die "RUNTIME_ROLE_NAME and MIGRATION_ROLE_NAME must differ."
  [[ "$PLANETSCALE_REPLICAS" =~ ^[0-9]+$ ]] || die "PLANETSCALE_REPLICAS must be a number."
}

check_tools() {
  require_command jq
  require_command pscale
  local version
  version="$(pscale version 2>/dev/null | first_version || true)"
  [[ -n "$version" ]] || die "Could not read the pscale version."
  version_ge "$version" "$PSCALE_MIN_VERSION" ||
    die "pscale $version is too old; $PSCALE_MIN_VERSION or newer is required (Cloudflare billing)."
  log "pscale $version"
}

check_wrangler() {
  if [[ -z "$WRANGLER_CMD" ]]; then
    require_command npx
  fi
  [[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]] || die "CLOUDFLARE_ACCOUNT_ID is required to create a Cloudflare-billed database."
  if [[ "${GITHUB_ACTIONS:-}" == "true" && -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
    die "CLOUDFLARE_API_TOKEN is required to mint the billing signature in GitHub Actions."
  fi
  local version
  version="$(wrangler_run --version 2>/dev/null | first_version || true)"
  [[ -n "$version" ]] || die "Could not read the Wrangler version."
  version_ge "$version" "$WRANGLER_MIN_VERSION" ||
    die "Wrangler $version is too old; $WRANGLER_MIN_VERSION or newer has 'hyperdrive planetscale signature'."
  log "wrangler $version"
}

# Fails before anything is created when a new role's password would have
# nowhere safe to go.
check_secret_sink() {
  [[ -n "$SECRETS_REPO" ]] ||
    die "A role must be created, but SECRETS_REPO is empty, so its one-time password could not be stored. Set SECRETS_REPO (and a GitHub token that can write '$SECRETS_ENVIRONMENT' environment secrets), or set MANAGE_ROLES=false."
  require_command gh
  gh secret list --env "$SECRETS_ENVIRONMENT" --repo "$SECRETS_REPO" >/dev/null 2>&1 ||
    die "Cannot read '$SECRETS_ENVIRONMENT' environment secrets of $SECRETS_REPO with the current gh credentials. The token needs the Environments repository permission (read and write)."
}

# Writes one environment secret from stdin. The value never reaches argv.
store_secret() {
  local name="$1"
  gh secret set "$name" --env "$SECRETS_ENVIRONMENT" --repo "$SECRETS_REPO" >/dev/null ||
    return 1
  log "Stored $name in the '$SECRETS_ENVIRONMENT' environment of $SECRETS_REPO."
}

# Prints "present", "missing", or exits on any other error.
database_state() {
  local out
  if out="$(ps_json database show "$PLANETSCALE_DATABASE" 2>/dev/null)"; then
    local kind
    kind="$(jq -r '.kind // empty' <<<"$out")"
    if [[ -n "$kind" && "$kind" != "postgresql" ]]; then
      die "Database $PLANETSCALE_DATABASE exists but its engine is '$kind', not postgresql."
    fi
    printf 'present\n'
    return 0
  fi
  if [[ "$(json_issue_code "$out")" == "NOT_FOUND" ]]; then
    printf 'missing\n'
    return 0
  fi
  die "pscale database show failed: $(json_error "$out")"
}

# Prints the JSON object of the role with exactly this name, or nothing.
find_role() {
  local name="$1" out
  if ! out="$(ps_json role list "$PLANETSCALE_DATABASE" "$PLANETSCALE_BRANCH" --name "$name" 2>/dev/null)"; then
    die "pscale role list failed: $(json_error "$out")"
  fi
  jq -c --arg name "$name" '(if type == "array" then . else [] end) | map(select(.name == $name)) | first // empty' <<<"$out"
}

create_database() {
  log "Creating PostgreSQL database $PLANETSCALE_DATABASE in $PLANETSCALE_REGION ($PLANETSCALE_CLUSTER_SIZE, $PLANETSCALE_REPLICAS replicas, PostgreSQL $PLANETSCALE_POSTGRES_MAJOR_VERSION), billed to Cloudflare account $CLOUDFLARE_ACCOUNT_ID."
  local raw billing account out
  # The signature is a credential: captured in memory, never echoed.
  if ! raw="$(wrangler_run hyperdrive planetscale signature 2>/dev/null)"; then
    die "wrangler hyperdrive planetscale signature failed. Create the database from the Cloudflare dashboard instead, then rerun with CREATE_DATABASE=false (docs/planetscale-bootstrap.md)."
  fi
  # Keep only the JSON object, in case Wrangler prints a banner first.
  if ! billing="$(printf '%s\n' "$raw" | sed -n '/^[[:space:]]*{/,$p' |
    jq -ce 'select(type == "object" and (.account_id | type) == "string" and (.timestamp | tostring | length) > 0 and (.signature | type) == "string" and (.signature | length) > 0) | {account_id, timestamp: (.timestamp | tostring), signature}' 2>/dev/null)"; then
    raw=""
    die "wrangler hyperdrive planetscale signature did not print the expected JSON (account_id, timestamp, signature)."
  fi
  raw=""
  mask "$(jq -r '.signature' <<<"$billing")"
  account="$(jq -r '.account_id' <<<"$billing")"
  [[ "$account" == "$CLOUDFLARE_ACCOUNT_ID" ]] ||
    die "The billing signature is for Cloudflare account $account, not CLOUDFLARE_ACCOUNT_ID ($CLOUDFLARE_ACCOUNT_ID)."
  if ! out="$(printf '%s' "$billing" | ps_json database create "$PLANETSCALE_DATABASE" \
    --engine postgresql \
    --region "$PLANETSCALE_REGION" \
    --cluster-size "$PLANETSCALE_CLUSTER_SIZE" \
    --major-version "$PLANETSCALE_POSTGRES_MAJOR_VERSION" \
    --replicas "$PLANETSCALE_REPLICAS" \
    --cloudflare-billing @- \
    --wait 2>/dev/null)"; then
    billing=""
    die "pscale database create failed: $(json_error "$out")"
  fi
  billing=""
  log "Created database $PLANETSCALE_DATABASE."
}

wait_for_branch() {
  local waited=0 out ready
  while :; do
    if out="$(ps_json branch show "$PLANETSCALE_DATABASE" "$PLANETSCALE_BRANCH" 2>/dev/null)"; then
      ready="$(jq -r '.ready // false' <<<"$out")"
      [[ "$ready" == "true" ]] && return 0
    elif [[ "$(json_issue_code "$out")" != "NOT_FOUND" ]]; then
      die "pscale branch show failed: $(json_error "$out")"
    fi
    ((waited < BRANCH_READY_TIMEOUT_SECONDS)) ||
      die "Branch $PLANETSCALE_DATABASE/$PLANETSCALE_BRANCH is not ready after ${BRANCH_READY_TIMEOUT_SECONDS}s."
    log "Waiting for branch $PLANETSCALE_DATABASE/$PLANETSCALE_BRANCH to be ready..."
    sleep "$BRANCH_READY_POLL_SECONDS"
    waited=$((waited + BRANCH_READY_POLL_SECONDS))
    # A zero poll interval (tests) must still terminate.
    ((BRANCH_READY_POLL_SECONDS > 0)) || waited=$((BRANCH_READY_TIMEOUT_SECONDS + 1))
  done
}

# Creates a role and hands its credential to GitHub without printing it.
# $1 role name, $2 inherited roles, $3 "runtime" or "migration".
create_role() {
  local name="$1" inherited="$2" kind="$3" out
  log "Creating role $name (inherits $inherited) on $PLANETSCALE_DATABASE/$PLANETSCALE_BRANCH."
  if ! out="$(ps_json role create "$PLANETSCALE_DATABASE" "$PLANETSCALE_BRANCH" "$name" --inherited-roles "$inherited" 2>/dev/null)"; then
    die "pscale role create $name failed: $(json_error "$out")"
  fi
  local password url
  # A missing field fails here; jq's error names the field, never a value.
  password="$(jq -r "$JQ_REQUIRE"' require("password")' <<<"$out" 2>/dev/null)" ||
    die "pscale role create $name returned no password. Nothing was stored; rotate the role: docs/planetscale-bootstrap.md#rotation."
  mask "$password"
  if [[ "$kind" == "runtime" ]]; then
    if ! printf '%s' "$password" | store_secret HYPERDRIVE_ORIGIN_PASSWORD; then
      die "Role $name was created but HYPERDRIVE_ORIGIN_PASSWORD could not be stored. Rotate it: docs/planetscale-bootstrap.md#rotation."
    fi
  else
    url="$(jq -r "$JQ_REQUIRE$JQ_MIGRATION_URL" <<<"$out" 2>/dev/null)" ||
      die "pscale role create $name lacks username, password, access_host_url or database_name. Nothing was stored; rotate the role: docs/planetscale-bootstrap.md#rotation."
    mask "$url"
    if ! printf '%s' "$url" | store_secret MIGRATION_DATABASE_URL; then
      die "Role $name was created but MIGRATION_DATABASE_URL could not be stored. Rotate it: docs/planetscale-bootstrap.md#rotation."
    fi
    url=""
  fi
  password=""
  # Only non-secret fields survive past this point.
  jq -c '{name, username, access_host_url, database_name}' <<<"$out"
}

summary() {
  local runtime="$1" migration="$2"
  local host user dbname migration_user
  host="$(jq -r '.access_host_url? // "unknown"' <<<"${runtime:-null}")"
  user="$(jq -r '.username? // "unknown"' <<<"${runtime:-null}")"
  dbname="$(jq -r '.database_name? // "unknown (see pscale role get)"' <<<"${runtime:-null}")"
  migration_user="$(jq -r '.username? // "unknown"' <<<"${migration:-null}")"
  local text
  text="$(
    cat <<EOF
PlanetScale bootstrap result (non-secret values):

| Setting | Value |
| --- | --- |
| Database | $PLANETSCALE_DATABASE |
| Branch | $PLANETSCALE_BRANCH |
| PLANETSCALE_HOST (branch host) | $host |
| PostgreSQL database name | $dbname |
| HYPERDRIVE_ORIGIN_USER (runtime connection username) | $user |
| Migration connection username | $migration_user |

Set PLANETSCALE_HOST and HYPERDRIVE_ORIGIN_USER as '$SECRETS_ENVIRONMENT' environment variables.
EOF
  )"
  printf '%s\n' "$text"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '%s\n' "$text" >>"$GITHUB_STEP_SUMMARY"
  fi
}

main() {
  validate_inputs
  check_tools

  local db_state runtime="" migration="" need_runtime=false need_migration=false
  db_state="$(database_state)"
  log "Database $PLANETSCALE_DATABASE: $db_state."

  if [[ "$db_state" == "missing" ]] && ! is_true "$CREATE_DATABASE"; then
    die "Database $PLANETSCALE_DATABASE does not exist in $PLANETSCALE_ORG and CREATE_DATABASE is false. Creating it starts billing: rerun with CREATE_DATABASE=true after approval, or create it from the Cloudflare dashboard."
  fi

  if is_true "$MANAGE_ROLES"; then
    if [[ "$db_state" == "present" ]]; then
      wait_for_branch
      runtime="$(find_role "$RUNTIME_ROLE_NAME")"
      migration="$(find_role "$MIGRATION_ROLE_NAME")"
    fi
    [[ -n "$runtime" ]] || need_runtime=true
    [[ -n "$migration" ]] || need_migration=true
    local role status
    for role in "$runtime" "$migration"; do
      [[ -n "$role" ]] || continue
      status="$(jq -r '.status // "active"' <<<"$role")"
      [[ "$status" == "active" ]] ||
        die "Role $(jq -r .name <<<"$role") exists with status '$status'. It is not reset automatically; see docs/planetscale-bootstrap.md#rotation."
    done
  fi

  local plan_db=keep plan_runtime=keep plan_migration=keep
  [[ "$db_state" == "missing" ]] && plan_db=create
  $need_runtime && plan_runtime=create
  $need_migration && plan_migration=create
  if ! is_true "$MANAGE_ROLES"; then
    plan_runtime=skip
    plan_migration=skip
  fi
  log "Plan: database=$plan_db, runtime role=$plan_runtime, migration role=$plan_migration."

  if is_true "$DRY_RUN"; then
    log "DRY_RUN=true: nothing was changed."
    return 0
  fi

  # Every precondition is checked before the first create.
  if [[ "$db_state" == "missing" ]]; then
    check_wrangler
  fi
  if $need_runtime || $need_migration; then
    check_secret_sink
  fi

  if [[ "$db_state" == "missing" ]]; then
    create_database
    if is_true "$MANAGE_ROLES"; then
      wait_for_branch
    fi
  fi

  if $need_runtime; then
    runtime="$(create_role "$RUNTIME_ROLE_NAME" "$RUNTIME_INHERITED_ROLES" runtime)"
  fi
  if $need_migration; then
    migration="$(create_role "$MIGRATION_ROLE_NAME" "$MIGRATION_INHERITED_ROLES" migration)"
  fi

  if is_true "$MANAGE_ROLES"; then
    summary "$runtime" "$migration"
  fi
  log "Bootstrap complete."
}

main "$@"
