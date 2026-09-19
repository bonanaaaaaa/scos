#!/usr/bin/env bash
# Ensure the Cloudflare account has a workers.dev subdomain, so `wrangler
# deploy` can publish the Worker there (#15).
#
# Usage: ensure-workers-subdomain.sh <subdomain>
# Prints "existing <name>" or "registered <name>" on stdout.
#
# Wrangler registers one only interactively (or when it detects a coding
# agent); in CI it answers "no" and fails. This makes the same API call it
# would: GET /accounts/{id}/workers/subdomain, and only when the account has
# none (Cloudflare error 10007), PUT the requested name. An existing
# subdomain is kept as it is, whatever its name. Idempotent.
#
# Environment: CLOUDFLARE_API_TOKEN (Workers Scripts Edit),
# CLOUDFLARE_ACCOUNT_ID. CLOUDFLARE_API_BASE_URL overrides the API (tests).
set -euo pipefail

subdomain="${1:?usage: ensure-workers-subdomain.sh <subdomain>}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
api="${CLOUDFLARE_API_BASE_URL:-https://api.cloudflare.com/client/v4}"
endpoint="$api/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain"

[[ "$subdomain" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] ||
  { echo "ensure-workers-subdomain: '$subdomain' is not a valid workers.dev subdomain." >&2; exit 2; }

# The token goes in a header read from stdin (curl -H @-), never in argv.
call() {
  printf 'Authorization: Bearer %s\n' "$CLOUDFLARE_API_TOKEN" |
    curl --silent --show-error --max-time 30 --header @- --header 'Content-Type: application/json' "$@"
}

errors() { jq -r '[.errors[]? | "\(.code): \(.message)"] | join("; ")' <<<"$1" 2>/dev/null; }

current="$(call "$endpoint")" || { echo "ensure-workers-subdomain: request failed." >&2; exit 1; }
if [[ "$(jq -r '.success' <<<"$current" 2>/dev/null)" == true ]]; then
  name="$(jq -r '.result.subdomain // empty' <<<"$current")"
  [[ -n "$name" ]] || { echo "ensure-workers-subdomain: Cloudflare reported an empty subdomain." >&2; exit 1; }
  echo "workers.dev subdomain already registered: $name.workers.dev" >&2
  printf 'existing %s\n' "$name"
  exit 0
fi
if ! jq -e 'any(.errors[]?; .code == 10007)' <<<"$current" >/dev/null 2>&1; then
  echo "ensure-workers-subdomain: could not read the account's subdomain ($(errors "$current"))." >&2
  exit 1
fi

echo "No workers.dev subdomain on the account; registering $subdomain.workers.dev." >&2
body="$(jq -cn --arg s "$subdomain" '{subdomain: $s}')"
created="$(call --request PUT --data "$body" "$endpoint")" ||
  { echo "ensure-workers-subdomain: request failed." >&2; exit 1; }
if [[ "$(jq -r '.success' <<<"$created" 2>/dev/null)" != true ]]; then
  echo "ensure-workers-subdomain: could not register $subdomain ($(errors "$created")). Set the WORKERS_DEV_SUBDOMAIN variable to another name, or register one at https://dash.cloudflare.com/$CLOUDFLARE_ACCOUNT_ID/workers/onboarding." >&2
  exit 1
fi
name="$(jq -r '.result.subdomain // empty' <<<"$created")"
[[ -n "$name" ]] || { echo "ensure-workers-subdomain: Cloudflare reported an empty subdomain." >&2; exit 1; }
echo "Registered $name.workers.dev" >&2
printf 'registered %s\n' "$name"
