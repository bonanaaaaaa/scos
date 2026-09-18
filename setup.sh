#!/usr/bin/env bash
# One-time local setup. Run again after dependency changes.
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

case "${1:-}" in
  -h|--help)
    printf 'Usage: ./setup.sh\nCheck Node/Corepack/Docker, prepare .env, and install locked dependencies.\n'
    exit 0 ;;
  '') ;;
  *) die "Unknown argument: $1. Use --help." ;;
esac
[[ $# -eq 0 ]] || die 'This script takes no arguments.'

for file in package.json pnpm-lock.yaml pnpm-workspace.yaml .node-version .env.example; do
  [[ -f "$file" ]] || die "Missing $file. Merge the SCOS workspace scaffold before running setup."
done

command -v node >/dev/null 2>&1 || die 'Install the Node.js version in .node-version first.'
required_node="$(tr -d '[:space:]' < .node-version)"
[[ "$(node --version)" == "v${required_node#v}" ]] || die "Use Node.js ${required_node#v} (see .node-version), then rerun setup."
command -v corepack >/dev/null 2>&1 || die 'Install Corepack, then rerun setup.'
command -v docker >/dev/null 2>&1 || die 'Install Docker with Docker Compose, then rerun setup.'
docker compose version >/dev/null 2>&1 || die 'Docker Compose v2 is required.'
docker info >/dev/null 2>&1 || die 'Start Docker, then rerun setup.'

required_pnpm="$(node -p 'require("./package.json").packageManager')"
[[ "$required_pnpm" == pnpm@* ]] || die 'package.json must pin pnpm in packageManager.'
actual_pnpm="$(corepack pnpm --version)"
[[ "pnpm@$actual_pnpm" == "${required_pnpm%%+*}" ]] || die "Corepack must select $required_pnpm; found pnpm@$actual_pnpm."

if [[ -e .env ]]; then
  printf 'Keeping existing .env.\n'
else
  (umask 077; cp .env.example .env)
  printf 'Created .env from local defaults.\n'
fi

printf 'Installing locked workspace dependencies...\n'
corepack pnpm install --frozen-lockfile
printf '\nSetup complete. Run ./dev.sh to start the shared database and this worktree API.\n'
