#!/usr/bin/env bash
# Tests ensure-workers-subdomain.sh against a stub curl (no network).
# Usage: bash infra/cloudflare/tests/ensure-workers-subdomain.test.sh
# Each check is a single-quoted condition evaluated later by check(), after
# run() sets $status.
# shellcheck disable=SC2016,SC2034
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="$root/infra/cloudflare/scripts/ensure-workers-subdomain.sh"
passes=0 failures=0
check() { if eval "$2"; then passes=$((passes + 1)); else failures=$((failures + 1)); echo "FAIL [$1]: $2"; fi; }

run() {
  STUB_STATE="$state" PATH="$root/infra/cloudflare/tests/stubs:$PATH" \
    CLOUDFLARE_API_TOKEN=cf-token-secret CLOUDFLARE_ACCOUNT_ID=acct123 \
    "$@" >"$state/out" 2>"$state/err" && status=0 || status=$?
}

state="$(mktemp -d)"
run "$script" scos-demo
check "registers when missing" '[[ $status == 0 ]]'
check "reports the registration" '[[ $(cat "$state/out") == "registered scos-demo" ]]'
check "one GET then one PUT" '[[ $(grep -c "^GET" "$state/calls.log") == 1 && $(grep -c "^PUT" "$state/calls.log") == 1 ]]'
check "token sent as a header" '! grep -q "auth=no" "$state/calls.log"'
check "token never in argv or output" '! grep -q cf-token-secret "$state/calls.log" "$state/out" "$state/err"'

run "$script" another-name
check "keeps an existing subdomain" '[[ $status == 0 && $(cat "$state/out") == "existing scos-demo" ]]'
check "no second PUT" '[[ $(grep -c "^PUT" "$state/calls.log") == 1 ]]'
rm -rf "$state"

state="$(mktemp -d)"
run env STUB_PUT_ERROR="subdomain unavailable" "$script" taken-name
check "unavailable name fails" '[[ $status != 0 ]]'
check "error explains the fix" 'grep -q "WORKERS_DEV_SUBDOMAIN" "$state/err"'
rm -rf "$state"

state="$(mktemp -d)"
run "$script" Bad_Name
check "invalid name refused before any call" '[[ $status == 2 && ! -s "$state/calls.log" ]]'
rm -rf "$state"

echo "$passes passed, $failures failed"
[[ $failures == 0 ]]
