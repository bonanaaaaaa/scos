#!/usr/bin/env bash
# Idempotent PlanetScale Postgres bootstrap for SCOS (issue #15).
#
# Creates, only when missing:
#   1. the PlanetScale Postgres database, billed through the Cloudflare account
#      (`wrangler hyperdrive planetscale signature | pscale database create ...`);
#   2. the runtime role used by Hyperdrive (pg_read_all_data,pg_write_all_data);
#   3. the migration role used by `prisma migrate deploy` and the seed job.
#
# The deploy workflow runs it first in every deployment (EXPORT_GITHUB_ENV=true),
# so a first deploy provisions the database and the roles. Roles are created,
# and rotated (ROTATE_ROLES), only there: a role's password is shown once, and
# the deploy's Terraform step stores it in the Terraform state in the same run
# (docs/deployment-pipeline.md#role-credentials-in-the-state). Anywhere else
# (planetscale-bootstrap.yml, a local run) the script refuses to create a role
# and only reports, or creates the database with MANAGE_ROLES=false.
#
# Anything that already exists is left alone: no database is recreated and no
# role password is reset unless ROTATE_ROLES names that role.
#
# Secrets (the billing signature and the role passwords) are held in memory
# only. They are never printed, never passed as a command-line argument and
# never written to GitHub secrets or variables. The one file exception: a
# password created or reset in this run is appended, masked, to the job's
# $GITHUB_ENV file for the Terraform plan step, which blanks it after use.
# Non-secret connection values (branch host, runtime username, database name)
# are read from PlanetScale and exported on every run.
#
# Inputs are environment variables; see docs/planetscale-bootstrap.md.

set -euo pipefail

readonly PSCALE_MIN_VERSION="0.313.0"
# `wrangler hyperdrive planetscale signature` first shipped in Wrangler 4.126.0.
readonly WRANGLER_MIN_VERSION="4.126.0"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly REPO_ROOT

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
EXPORT_GITHUB_ENV="${EXPORT_GITHUB_ENV:-false}"
# none, runtime, migration or both: reset these roles' passwords (rotation).
ROTATE_ROLES="${ROTATE_ROLES:-none}"
# The PostgreSQL database name for a migration URL when `role reset` does not
# report one (`role list` never does). The deploy passes, in order:
# HYPERDRIVE_ORIGIN_DATABASE, the name in the currently stored URL, postgres.
ORIGIN_DATABASE_FALLBACK="${ORIGIN_DATABASE_FALLBACK:-postgres}"
# The lockfile-pinned Wrangler of @scos/api (after `pnpm install --frozen-lockfile`).
WRANGLER_CMD="${WRANGLER_CMD:-$REPO_ROOT/apps/api/node_modules/.bin/wrangler}"
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

wrangler_run() { "$WRANGLER_CMD" "$@"; }

# Runs pscale with JSON output. Prints stdout; returns pscale's exit status.
# pscale reads PLANETSCALE_SERVICE_TOKEN_ID and PLANETSCALE_SERVICE_TOKEN from
# the environment, so the token never appears in process arguments.
ps_json() {
  pscale "$@" --org "$PLANETSCALE_ORG" --format json
}

# jq helper: require("field") yields a non-empty string field or raises an
# error naming only the field. Used so a missing field can never become the
# literal string "null" in a stored credential.
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
  for name in CREATE_DATABASE MANAGE_ROLES DRY_RUN EXPORT_GITHUB_ENV; do
    value="${!name}"
    [[ "$value" == "true" || "$value" == "false" ]] || die "$name must be true or false, got '$value'."
  done
  for name in PLANETSCALE_DATABASE PLANETSCALE_BRANCH RUNTIME_ROLE_NAME MIGRATION_ROLE_NAME; do
    value="${!name}"
    [[ "$value" =~ ^[a-z][a-z0-9_-]*$ ]] || die "$name must match ^[a-z][a-z0-9_-]*\$, got '$value'."
  done
  [[ "$RUNTIME_ROLE_NAME" != "$MIGRATION_ROLE_NAME" ]] || die "RUNTIME_ROLE_NAME and MIGRATION_ROLE_NAME must differ."
  [[ "$PLANETSCALE_REPLICAS" =~ ^[0-9]+$ ]] || die "PLANETSCALE_REPLICAS must be a number."
  [[ "$ORIGIN_DATABASE_FALLBACK" =~ ^[A-Za-z0-9_-]+$ ]] ||
    die "ORIGIN_DATABASE_FALLBACK must be a bare database name, got '$ORIGIN_DATABASE_FALLBACK'."
  [[ "$ROTATE_ROLES" =~ ^(none|runtime|migration|both)$ ]] ||
    die "ROTATE_ROLES must be none, runtime, migration or both, got '$ROTATE_ROLES'."
  if [[ "$ROTATE_ROLES" != none ]] && ! is_true "$MANAGE_ROLES"; then
    die "ROTATE_ROLES needs MANAGE_ROLES=true."
  fi
  if is_true "$EXPORT_GITHUB_ENV"; then
    [[ "${GITHUB_ACTIONS:-}" == "true" && -n "${GITHUB_ENV:-}" ]] ||
      die "EXPORT_GITHUB_ENV=true works only inside GitHub Actions (GITHUB_ENV is unset)."
  fi
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
  command -v "$WRANGLER_CMD" >/dev/null 2>&1 ||
    die "Wrangler not found at $WRANGLER_CMD. Run 'pnpm install --frozen-lockfile' at the repository root, or set WRANGLER_CMD."
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

# A new or reset password must reach the deploy's Terraform step, which stores
# it in the state. Outside the deploy it would be lost, so nothing is created
# or reset there.
check_credential_sink() {
  is_true "$EXPORT_GITHUB_ENV" ||
    die "A role must be $1, but its one-time password would be lost here. Roles are created and rotated only by the deploy (Deploy Prod), which stores the credential in the Terraform state. Run the deploy, or set MANAGE_ROLES=false for a database-only run."
}

# Appends NAME=value to $GITHUB_ENV for the later steps of this job. Values
# are single-line: a newline could inject another variable. Secret values are
# masked by the caller before this runs.
export_env() {
  local name="$1" value="$2"
  is_true "$EXPORT_GITHUB_ENV" || return 0
  [[ -n "$value" ]] || return 0
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "Refusing to export $name: the value spans lines."
  printf '%s=%s\n' "$name" "$value" >>"$GITHUB_ENV"
}

# Non-secret values reported by pscale must look like a host or an identifier
# before they reach $GITHUB_ENV.
non_secret_field() {
  local json="$1" field="$2" pattern="$3" value
  value="$(jq -r --arg f "$field" '(.[$f] // empty) | strings' <<<"${json:-null}" 2>/dev/null || true)"
  [[ -z "$value" || "$value" =~ $pattern ]] || die "pscale reported an unexpected $field; not exported."
  printf '%s' "$value"
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
  local raw billing account out errlog
  # The signature is a credential: captured in memory (stdout), never echoed.
  # Wrangler's stderr carries only its banner and errors (the Cloudflare API
  # endpoint, error code and hint), never the signature, so it goes to a
  # scratch file and is shown when the command fails.
  errlog="$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/wrangler-signature.XXXXXX")"
  # WRANGLER_LOG=info: debug logging would print the signature response.
  if ! raw="$(WRANGLER_LOG=info wrangler_run hyperdrive planetscale signature 2>"$errlog")"; then
    raw=""
    {
      echo "Wrangler output:"
      # Colour codes stripped (portable), and each line indented so text in
      # a Cloudflare error is never read as a workflow command.
      sed -e $'s/\x1b\\[[0-9;]*m//g' -e 's/^/  /' "$errlog"
    } >&2
    rm -f "$errlog"
    die "wrangler hyperdrive planetscale signature failed (see Wrangler's output above; a Cloudflare API authentication error usually means CLOUDFLARE_API_TOKEN is invalid, expired, or lacks a permission this call needs). Or create the database from the Cloudflare dashboard, then rerun with CREATE_DATABASE=false (docs/planetscale-bootstrap.md)."
  fi
  rm -f "$errlog"
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

# Creates or resets a role and hands its credential to the deploy's Terraform
# step (masked, via $GITHUB_ENV) without printing it.
# $1 "create" or "reset", $2 role name, $3 inherited roles (create) or the
# role's `role list` JSON (reset), $4 "runtime" or "migration".
issue_credential() {
  local action="$1" name="$2" arg="$3" kind="$4" out listed=""
  if [[ "$action" == create ]]; then
    log "Creating role $name (inherits $arg) on $PLANETSCALE_DATABASE/$PLANETSCALE_BRANCH."
    if ! out="$(ps_json role create "$PLANETSCALE_DATABASE" "$PLANETSCALE_BRANCH" "$name" --inherited-roles "$arg" 2>/dev/null)"; then
      die "pscale role create $name failed: $(json_error "$out")"
    fi
  else
    listed="$arg"
    local id
    id="$(jq -r '.id // empty' <<<"$listed")"
    [[ "$id" =~ ^[A-Za-z0-9_-]+$ ]] || die "Role $name has no usable id in pscale role list."
    log "Resetting the password of role $name on $PLANETSCALE_DATABASE/$PLANETSCALE_BRANCH (rotation)."
    if ! out="$(ps_json role reset "$PLANETSCALE_DATABASE" "$PLANETSCALE_BRANCH" "$id" --force 2>/dev/null)"; then
      die "pscale role reset $name failed: $(json_error "$out")"
    fi
    # Fields the reset output lacks come from the role list (never the
    # password, which only the reset returns).
    out="$(jq -c --argjson listed "$listed" '($listed | del(.password)) + with_entries(select(.value != null))' <<<"$out" 2>/dev/null)" ||
      die "pscale role reset $name returned unparseable output. Rotate it again."
    if [[ "$kind" == migration && -z "$(jq -r '.database_name // empty | strings' <<<"$out")" ]]; then
      log "pscale role reset did not report database_name; using '$ORIGIN_DATABASE_FALLBACK' for the migration URL."
      out="$(jq -c --arg db "$ORIGIN_DATABASE_FALLBACK" '.database_name = $db' <<<"$out")"
    fi
  fi
  local password url
  # A missing field fails here; jq's error names the field, never a value.
  password="$(jq -r "$JQ_REQUIRE"' require("password")' <<<"$out" 2>/dev/null)" ||
    die "pscale role $action $name returned no password. Nothing was exported; rotate the role: docs/deployment-pipeline.md#role-credentials-in-the-state."
  mask "$password"
  if [[ "$kind" == "runtime" ]]; then
    export_env BOOTSTRAP_PLANETSCALE_RUNTIME_PASSWORD "$password"
  else
    url="$(jq -r "$JQ_REQUIRE$JQ_MIGRATION_URL" <<<"$out" 2>/dev/null)" ||
      die "pscale role $action $name lacks username, password, access_host_url or database_name. Nothing was exported; rotate the role: docs/deployment-pipeline.md#role-credentials-in-the-state."
    mask "$url"
    export_env BOOTSTRAP_MIGRATION_DATABASE_URL "$url"
    url=""
  fi
  password=""
  # Only non-secret fields survive past this point.
  jq -c '{name, username, access_host_url, database_name}' <<<"$out"
}

# Publishes the non-secret connection values: job summary and $GITHUB_ENV
# (BOOTSTRAP_*). Operator variables of the same names override them in the
# deploy.
publish_connection_values() {
  local runtime="$1" migration="$2"
  local host user dbname migration_user
  host="$(non_secret_field "$runtime" access_host_url '^[A-Za-z0-9.-]+$')"
  user="$(non_secret_field "$runtime" username '^[A-Za-z0-9._-]+$')"
  dbname="$(non_secret_field "$runtime" database_name '^[A-Za-z0-9_-]+$')"
  migration_user="$(non_secret_field "$migration" username '^[A-Za-z0-9._-]+$')"

  export_env BOOTSTRAP_PLANETSCALE_HOST "$host"
  export_env BOOTSTRAP_HYPERDRIVE_ORIGIN_USER "$user"
  export_env BOOTSTRAP_HYPERDRIVE_ORIGIN_DATABASE "$dbname"

  local text
  text="$(
    cat <<SUMMARY
PlanetScale bootstrap result (non-secret values):

| Setting | Value |
| --- | --- |
| Database | $PLANETSCALE_DATABASE |
| Branch | $PLANETSCALE_BRANCH |
| PLANETSCALE_HOST (branch host) | ${host:-unknown} |
| HYPERDRIVE_ORIGIN_DATABASE (PostgreSQL database name) | ${dbname:-not reported by this run; Terraform keeps the stored one} |
| HYPERDRIVE_ORIGIN_USER (runtime connection username) | ${user:-unknown} |
| Migration connection username | ${migration_user:-unknown} |
SUMMARY
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
  local reset_runtime=false reset_migration=false
  db_state="$(database_state)"
  log "Database $PLANETSCALE_DATABASE: $db_state."

  if [[ "$db_state" == "missing" ]] && ! is_true "$CREATE_DATABASE"; then
    die "Database $PLANETSCALE_DATABASE does not exist in $PLANETSCALE_ORG and CREATE_DATABASE is false. Creating it starts billing: rerun with CREATE_DATABASE=true once that is intended, or create it from the Cloudflare dashboard."
  fi

  if is_true "$MANAGE_ROLES"; then
    if [[ "$db_state" == "present" ]]; then
      wait_for_branch
      runtime="$(find_role "$RUNTIME_ROLE_NAME")"
      migration="$(find_role "$MIGRATION_ROLE_NAME")"
    fi
    [[ -n "$runtime" ]] || need_runtime=true
    [[ -n "$migration" ]] || need_migration=true
    # Rotation resets an existing role; a missing one is created anyway.
    if [[ "$ROTATE_ROLES" == runtime || "$ROTATE_ROLES" == both ]] && ! $need_runtime; then
      reset_runtime=true
    fi
    if [[ "$ROTATE_ROLES" == migration || "$ROTATE_ROLES" == both ]] && ! $need_migration; then
      reset_migration=true
    fi
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
  $reset_runtime && plan_runtime=reset
  $reset_migration && plan_migration=reset
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
    check_credential_sink created
  fi
  if $reset_runtime || $reset_migration; then
    check_credential_sink reset
  fi

  if [[ "$db_state" == "missing" ]]; then
    create_database
    if is_true "$MANAGE_ROLES"; then
      wait_for_branch
    fi
  fi

  if $need_runtime; then
    runtime="$(issue_credential create "$RUNTIME_ROLE_NAME" "$RUNTIME_INHERITED_ROLES" runtime)"
  elif $reset_runtime; then
    runtime="$(issue_credential reset "$RUNTIME_ROLE_NAME" "$runtime" runtime)"
  fi
  if $need_migration; then
    migration="$(issue_credential create "$MIGRATION_ROLE_NAME" "$MIGRATION_INHERITED_ROLES" migration)"
  elif $reset_migration; then
    migration="$(issue_credential reset "$MIGRATION_ROLE_NAME" "$migration" migration)"
  fi

  if is_true "$MANAGE_ROLES"; then
    publish_connection_values "$runtime" "$migration"
  fi
  log "Bootstrap complete."
}

main "$@"
