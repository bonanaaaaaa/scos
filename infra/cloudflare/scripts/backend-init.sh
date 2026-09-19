#!/usr/bin/env bash
# Initialize a Terraform root against the R2 state bucket.
#
# Usage: backend-init.sh <root-dir> [state-key]
#
# Non-secret settings come from the GitHub environment's variables:
#   TF_STATE_BUCKET, TF_STATE_ENDPOINT, TF_STATE_REGION, TF_STATE_KEY,
#   TF_STATE_WORKSPACE_PREFIX
# The fixed R2 settings (path-style, skip_* flags, use_lockfile) are in the
# root's backend block. The R2 key pair is read by Terraform itself from
# AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY; it never reaches a file or an
# argument. The optional second argument overrides TF_STATE_KEY.
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: $0 <root-dir> [state-key]" >&2
  exit 2
fi
root_dir=$1
state_key=${2:-${TF_STATE_KEY:-}}

missing=()
for name in TF_STATE_BUCKET TF_STATE_ENDPOINT TF_STATE_REGION TF_STATE_WORKSPACE_PREFIX \
  AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
  if [[ -z ${!name:-} ]]; then
    missing+=("$name")
  fi
done
if [[ -z $state_key ]]; then
  missing+=("TF_STATE_KEY")
fi
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "backend-init: missing required environment: ${missing[*]}" >&2
  exit 2
fi

# The endpoint is a bare origin: https://<account_id>.r2.cloudflarestorage.com
# on R2. Plain http is accepted only for a loopback test server (a local
# MinIO). Credentials in the URL are rejected.
endpoint=${TF_STATE_ENDPOINT%/}
if [[ ! $endpoint =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ &&
  ! $endpoint =~ ^http://(127\.0\.0\.1|localhost)(:[0-9]+)?$ ]]; then
  echo "backend-init: TF_STATE_ENDPOINT must be an https:// origin with no path or credentials." >&2
  exit 2
fi
for value in "$TF_STATE_BUCKET" "$state_key" "$TF_STATE_WORKSPACE_PREFIX" "$TF_STATE_REGION"; do
  if [[ ! $value =~ ^[A-Za-z0-9._/-]+$ ]]; then
    echo "backend-init: TF_STATE_* values may only contain letters, digits, '.', '_', '-' and '/'." >&2
    exit 2
  fi
done

# Non-secret values only; removed on exit.
backend_file=$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/backend.XXXXXX")
trap 'rm -f "$backend_file"' EXIT
cat >"$backend_file" <<EOF
bucket               = "${TF_STATE_BUCKET}"
key                  = "${state_key}"
region               = "${TF_STATE_REGION}"
workspace_key_prefix = "${TF_STATE_WORKSPACE_PREFIX}"
endpoints            = { s3 = "${endpoint}" }
EOF

terraform -chdir="$root_dir" init -input=false -reconfigure -no-color \
  -backend-config="$backend_file"
