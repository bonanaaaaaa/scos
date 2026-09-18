#!/usr/bin/env bash
set -euo pipefail

node "$GITHUB_WORKSPACE/scripts/validate-pr-title.mjs"
