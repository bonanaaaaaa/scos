#!/usr/bin/env bash
# Fail unless main is still at the commit being deployed.
#
# Usage: require-main-head.sh <sha> <before-what>
#
# The deploy job calls this at its start, before the database bootstrap,
# before terraform apply and before wrangler deploy. "Re-run failed jobs"
# reuses the gate's old commit, and a run can wait in the concurrency groups
# while main moves on, so the gate's own check is not enough: an older commit
# must never overwrite a newer one. The newer
# commit's own CI run deploys it. Needs GH_TOKEN (contents: read) and
# GITHUB_REPOSITORY.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <sha> <before-what>" >&2
  exit 2
fi
sha=$1
stage=$2
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

head=$(gh api "repos/$GITHUB_REPOSITORY/commits/main" --jq '.sha')
if [[ ! $head =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::Could not read the head of main." >&2
  exit 1
fi
if [[ $head != "$sha" ]]; then
  echo "::error title=Stale deploy stopped::main is at $head, not $sha. Stopped $stage so an older commit never overwrites a newer one; the newer commit's CI run deploys it."
  exit 1
fi
echo "main is still at $sha ($stage)."
