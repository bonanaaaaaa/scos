#!/usr/bin/env bash
# Prove that the state backend rejects a second concurrent Terraform run.
#
# Usage: prove-state-lock.sh [state-key]
#
# 1. A holder process (`terraform apply`) acquires the lock on a throwaway
#    key and keeps it while it waits at its approval prompt. (`terraform
#    console` no longer takes the lock in current Terraform releases.)
# 2. A contender `terraform plan -lock-timeout=0` against the same key must
#    fail with "Error acquiring the state lock".
# 3. The holder is answered "no" (nothing is created and the state is never
#    written), exits, releasing the lock, and a final plan must succeed.
#
# Any other outcome exits non-zero, so the deploy workflow never applies with
# a lock it has not seen work. It uses the resource-free root in
# ../lock-proof (no provider, no credential besides the R2 key pair), and the
# key defaults to "${TF_STATE_WORKSPACE_PREFIX}/lock-proof/terraform.tfstate",
# never an environment's real state key. Backend settings: see
# backend-init.sh.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
key=${1:-${TF_STATE_WORKSPACE_PREFIX:?TF_STATE_WORKSPACE_PREFIX is required}/lock-proof/terraform.tfstate}
if [[ $key == "${TF_STATE_KEY:-}" ]]; then
  echo "prove-state-lock: refusing to use the real state key; pick a throwaway key." >&2
  exit 2
fi

work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/lock-proof.XXXXXX")
holder_pid=
cleanup() {
  exec 3>&- 2>/dev/null || true
  if [[ -n $holder_pid ]] && kill -0 "$holder_pid" 2>/dev/null; then
    kill "$holder_pid" 2>/dev/null || true
    wait "$holder_pid" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

cp "$script_dir/../lock-proof/main.tf" "$work/main.tf"
"$script_dir/backend-init.sh" "$work" "$key" >/dev/null
echo "Lock proof on key: $key"

# 1. The holder. Its INFO log (private to this run, never printed) says when
#    the lock is held; its stdin is a FIFO held open on fd 3, so it waits at
#    the approval prompt until we answer.
mkfifo "$work/holder.stdin"
(
  export TF_LOG=INFO TF_LOG_PATH="$work/holder.log"
  exec terraform -chdir="$work" apply -no-color <"$work/holder.stdin" >"$work/holder.out" 2>&1
) &
holder_pid=$!
exec 3>"$work/holder.stdin"

held=false
for _ in $(seq 1 60); do
  if grep -q "Locked remote state" "$work/holder.log" 2>/dev/null; then
    held=true
    break
  fi
  if ! kill -0 "$holder_pid" 2>/dev/null; then
    break
  fi
  sleep 0.5
done
if [[ $held != true ]]; then
  echo "prove-state-lock: FAIL: the holder never acquired the lock." >&2
  exit 1
fi
echo "1. Holder (terraform apply at its approval prompt, pid $holder_pid) holds the lock."

# 2. The contender must be rejected.
set +e
terraform -chdir="$work" plan -input=false -lock-timeout=0 -no-color >"$work/contender.out" 2>&1
contender_status=$?
set -e
if [[ $contender_status -eq 0 ]]; then
  echo "prove-state-lock: FAIL: a second run was NOT rejected while the lock was held." >&2
  exit 1
fi
if ! grep -q "Error acquiring the state lock" "$work/contender.out"; then
  echo "prove-state-lock: FAIL: the second run failed (exit $contender_status) for another reason:" >&2
  sed 's/^/  | /' "$work/contender.out" >&2
  exit 1
fi
echo "2. Contender (terraform plan -lock-timeout=0) was rejected (exit $contender_status):"
sed -n '/Error acquiring the state lock/,/^  Info:/p' "$work/contender.out" | sed 's/^/  | /'

# 3. Release: answer "no"; the apply is cancelled and unlocks.
# A cancelled apply exits non-zero, so the check is on its output.
echo no >&3
exec 3>&-
wait "$holder_pid" || true
holder_pid=
if ! grep -q "Apply cancelled" "$work/holder.out"; then
  echo "prove-state-lock: FAIL: the holder's apply was not cancelled." >&2
  exit 1
fi
if ! grep -q "Unlocked remote state\|Attempting to unlock remote state" "$work/holder.log"; then
  echo "prove-state-lock: FAIL: the holder did not release the lock." >&2
  exit 1
fi
if ! terraform -chdir="$work" plan -input=false -lock-timeout=0 -no-color >"$work/after.out" 2>&1; then
  echo "prove-state-lock: FAIL: the lock was not released; a plan after the holder exited failed:" >&2
  sed 's/^/  | /' "$work/after.out" >&2
  exit 1
fi
echo "3. Holder exited and released the lock; a new plan acquired and released it."
echo "State lock proof: PASS"
