#!/usr/bin/env bash
# Bounded state backups in the R2 state bucket (R2 has no object versioning).
#
# Usage:
#   state-backup.sh backup <label>     copy the current state object to the
#                                      backup prefix, then keep the newest
#                                      $STATE_BACKUP_KEEP (default 10)
#   state-backup.sh list               list the backups, newest last
#   state-backup.sh restore <key>      copy a backup over the state object
#                                      (operator use; see
#                                      docs/deployment-pipeline.md)
#
# Settings: TF_STATE_BUCKET, TF_STATE_ENDPOINT, TF_STATE_REGION, TF_STATE_KEY
# and the R2 key pair in AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY. Backups go
# to "<dir of TF_STATE_KEY>/state-backups/" in the same private bucket. Copies
# are server-side: the state never reaches the runner's disk or a log.
set -euo pipefail

usage() {
  echo "usage: $0 backup <label> | list | restore <backup-key>" >&2
  exit 2
}
[[ $# -ge 1 ]] || usage
command=$1

for name in TF_STATE_BUCKET TF_STATE_ENDPOINT TF_STATE_REGION TF_STATE_KEY \
  AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
  if [[ -z ${!name:-} ]]; then
    echo "state-backup: $name is required." >&2
    exit 2
  fi
done

bucket=$TF_STATE_BUCKET
state_key=$TF_STATE_KEY
prefix="${state_key%/*}/state-backups/"
keep=${STATE_BACKUP_KEEP:-10}
if [[ ! $keep =~ ^[1-9][0-9]*$ ]]; then
  echo "state-backup: STATE_BACKUP_KEEP must be a positive integer." >&2
  exit 2
fi

# R2 does not implement the newer default request checksums of the AWS CLI;
# only send them when an operation requires them.
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
export AWS_DEFAULT_REGION=$TF_STATE_REGION AWS_REGION=$TF_STATE_REGION
export AWS_PAGER=""

s3api() {
  aws --endpoint-url "${TF_STATE_ENDPOINT%/}" s3api "$@"
}

# Prints "present", "absent", or fails on any other error.
state_object() {
  local error_file status
  error_file=$(mktemp)
  set +e
  s3api head-object --bucket "$bucket" --key "$1" >/dev/null 2>"$error_file"
  status=$?
  set -e
  if [[ $status -eq 0 ]]; then
    rm -f "$error_file"
    echo present
  elif grep -qE '\((404|NoSuchKey|NotFound)\)|Not Found' "$error_file"; then
    rm -f "$error_file"
    echo absent
  else
    echo "state-backup: cannot read s3://$bucket/$1:" >&2
    cat "$error_file" >&2
    rm -f "$error_file"
    return 1
  fi
}

# A failed listing returns non-zero explicitly (errexit is not inherited by
# command substitution); only "no backups" is tolerated (grep exits 1 when
# nothing is left after dropping the CLI's "None").
list_backups() {
  local keys
  keys=$(s3api list-objects-v2 --bucket "$bucket" --prefix "$prefix" \
    --query 'Contents[].Key' --output text) || return 1
  tr '\t' '\n' <<<"$keys" | { grep -v -e '^None$' -e '^$' || true; } | LC_ALL=C sort
}

case $command in
  backup)
    [[ $# -eq 2 ]] || usage
    label=$2
    if [[ ! $label =~ ^[A-Za-z0-9._-]{1,64}$ ]]; then
      echo "state-backup: the label may only contain letters, digits, '.', '_' and '-'." >&2
      exit 2
    fi
    # Assigned first so that a read error stops the script (errexit).
    current=$(state_object "$state_key")
    if [[ $current == absent ]]; then
      echo "No state object yet (first apply): nothing to back up."
      exit 0
    fi
    target="${prefix}terraform.tfstate.$(date -u +%Y%m%dT%H%M%SZ).${label}"
    s3api copy-object --bucket "$bucket" --copy-source "$bucket/$state_key" \
      --key "$target" >/dev/null
    echo "Backed up the state to s3://$bucket/$target"
    # Assigned first so that a failed listing stops the script (errexit);
    # a process substitution would hide it.
    listing=$(list_backups)
    backups=()
    while IFS= read -r line; do
      [[ -n $line ]] && backups+=("$line")
    done <<<"$listing"
    excess=$((${#backups[@]} - keep))
    for ((i = 0; i < excess; i++)); do
      s3api delete-object --bucket "$bucket" --key "${backups[$i]}" >/dev/null
      echo "Pruned the old backup ${backups[$i]}"
    done
    echo "Keeping $((${#backups[@]} - (excess > 0 ? excess : 0))) backup(s) (at most $keep)."
    ;;
  list)
    [[ $# -eq 1 ]] || usage
    listing=$(list_backups)
    [[ -z $listing ]] || echo "$listing"
    ;;
  restore)
    [[ $# -eq 2 ]] || usage
    source_key=$2
    if [[ $source_key != "$prefix"* ]]; then
      echo "state-backup: restore only from $prefix" >&2
      exit 2
    fi
    backup=$(state_object "$source_key")
    lock=$(state_object "$state_key.tflock")
    if [[ $backup == absent ]]; then
      echo "state-backup: no backup at $source_key" >&2
      exit 1
    fi
    if [[ $lock != absent ]]; then
      echo "state-backup: the state is locked ($state_key.tflock); a run is in progress. Not restoring." >&2
      exit 1
    fi
    s3api copy-object --bucket "$bucket" --copy-source "$bucket/$source_key" \
      --key "$state_key" >/dev/null
    echo "Restored s3://$bucket/$state_key from $source_key. Run a plan before any apply."
    ;;
  *)
    usage
    ;;
esac
