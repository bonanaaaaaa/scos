#!/usr/bin/env bash
# Reuse shared PostgreSQL; isolate each worktree in its own database.
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

case "${1:-}" in
  -h|--help)
    printf 'Usage: [PORT=8080] [SCOS_POSTGRES_CONTAINER=name] ./dev.sh\nReuse or start shared PostgreSQL and create this worktree database. Ctrl+C stops only the API.\n'
    exit 0 ;;
  '') ;;
  *) die "Unknown argument: $1. Use --help." ;;
esac
[[ $# -eq 0 ]] || die 'This script takes no arguments.'

for file in package.json .node-version turbo.json; do
  [[ -f "$file" ]] || die "Missing $file. Merge the SCOS workspace scaffold, then run ./setup.sh."
done
[[ -f .env && -d node_modules ]] || die 'Run ./setup.sh first to prepare .env and dependencies.'
command -v node >/dev/null 2>&1 || die 'Install the Node.js version in .node-version first.'
required_node="$(tr -d '[:space:]' < .node-version)"
[[ "$(node --version)" == "v${required_node#v}" ]] || die "Use Node.js ${required_node#v}, then rerun ./dev.sh."
command -v pnpm >/dev/null 2>&1 || die 'Install pnpm, then run ./setup.sh.'
command -v docker >/dev/null 2>&1 || die 'Install Docker first.'
docker info >/dev/null 2>&1 || die 'Start Docker, then rerun ./dev.sh.'

# Discover Compose postgres services and ordinary official-image containers.
# Exclude the scaffold's disposable postgres-test service.
find_postgres() {
  docker ps "$@" --format '{{json .}}' | node --input-type=module -e '
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    for (const line of input.trim().split("\n").filter(Boolean)) {
      const item = JSON.parse(line);
      const labels = Object.fromEntries((item.Labels || "").split(",").map(label => label.split("=")));
      const service = labels["com.docker.compose.service"];
      if (service === "postgres" || (!service && /^(?:docker\.io\/)?(?:library\/)?postgres(?::|@|$)/.test(item.Image))) {
        console.log(item.ID);
      }
    }
  '
}

container="${SCOS_POSTGRES_CONTAINER:-}"
if [[ -z "$container" ]]; then
  container="$(find_postgres)"
  if [[ -z "$container" ]]; then
    container="$(find_postgres --all)"
  fi
  [[ "$container" != *$'\n'* ]] || die 'Multiple PostgreSQL containers found. Set SCOS_POSTGRES_CONTAINER to the shared development container.'
fi
if [[ -z "$container" ]]; then
  [[ -f compose.yaml ]] || die 'Missing compose.yaml. Merge the SCOS workspace scaffold first.'
  docker compose version >/dev/null 2>&1 || die 'Docker Compose v2 is required.'
  printf 'Starting the shared SCOS PostgreSQL container...\n'
  # A fixed project name shares one container/volume across every worktree.
  compose=(docker compose --project-name scos-local -f "$ROOT_DIR/compose.yaml")
  "${compose[@]}" up -d --wait --wait-timeout 60 postgres
  container="$("${compose[@]}" ps -q postgres)"
  [[ -n "$container" ]] || die 'Could not locate the shared PostgreSQL container.'
elif [[ "$(docker inspect --format '{{.State.Running}}' "$container")" != true ]]; then
  printf 'Starting existing PostgreSQL container %s...\n' "$container"
  docker start "$container" >/dev/null
fi

pg_user="$(docker exec "$container" sh -c 'printf "%s" "${POSTGRES_USER:-postgres}"')"
ready=false
for ((attempt = 0; attempt < 30; attempt++)); do
  if docker exec "$container" pg_isready -t 1 -U "$pg_user" -d postgres >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
[[ "$ready" == true ]] || die 'PostgreSQL did not become ready; inspect the shared container logs.'
pg_password="${SCOS_POSTGRES_PASSWORD:-$(docker exec "$container" sh -c 'if [ -n "${POSTGRES_PASSWORD:-}" ]; then printf "%s" "$POSTGRES_PASSWORD"; elif [ -n "${POSTGRES_PASSWORD_FILE:-}" ]; then cat "$POSTGRES_PASSWORD_FILE"; fi')}"
[[ -n "$pg_password" ]] || die 'Set SCOS_POSTGRES_PASSWORD to the existing local database password.'
address="$(docker port "$container" 5432/tcp)"
address="${address%%$'\n'*}"
pg_port="${address##*:}"
[[ "$pg_port" =~ ^[0-9]+$ ]] || die 'The existing container must publish PostgreSQL port 5432 to the host.'
case "${address%:*}" in
  127.0.0.1|0.0.0.0|'[::]'|'[::1]') ;;
  *) die 'The existing PostgreSQL port must be accessible on localhost.' ;;
esac
pg_host=127.0.0.1
[[ "${address%:*}" != '[::1]' ]] || pg_host='[::1]'

# Stable, collision-resistant identity for this path, including detached worktrees.
database_name="scos_wt_$(node -p 'require("node:crypto").createHash("sha256").update(process.cwd()).digest("hex").slice(0, 24)')"
printf 'Preparing worktree database %s in existing container %s...\n' "$database_name" "$container"
# One session holds a lock across the existence check and CREATE DATABASE,
# making simultaneous launches idempotent. No existing database is reset.
docker exec -i "$container" psql -X -U "$pg_user" -d postgres -v ON_ERROR_STOP=1 \
  --set="db_name=$database_name" >/dev/null <<'SQL'
SET statement_timeout = '60s';
SELECT pg_advisory_lock(730281940);
SELECT format('CREATE DATABASE %I', :'db_name')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'db_name')
\gexec
SELECT pg_advisory_unlock(730281940);
SQL

DATABASE_URL="$(SCOS_DB_USER="$pg_user" SCOS_DB_PASSWORD="$pg_password" SCOS_DB_HOST="$pg_host" SCOS_DB_PORT="$pg_port" SCOS_DB_NAME="$database_name" node <<'NODE'
const e = process.env;
console.log(`postgresql://${encodeURIComponent(e.SCOS_DB_USER)}:${encodeURIComponent(e.SCOS_DB_PASSWORD)}@${e.SCOS_DB_HOST}:${e.SCOS_DB_PORT}/${e.SCOS_DB_NAME}`);
NODE
)"
unset pg_password
export DATABASE_URL
# Apply pending migrations, then insert any missing seed warehouses. Both are
# idempotent: existing rows and consumed stock are never reset or replenished.
# The schema's uuidv7() defaults require PostgreSQL 18 or newer.
server_version_num="$(docker exec "$container" psql -X -At -U "$pg_user" -d postgres -c 'SHOW server_version_num')"
[[ "$server_version_num" =~ ^[0-9]+$ ]] || die 'Could not read the shared PostgreSQL server version.'
(( server_version_num >= 180000 )) \
  || die "PostgreSQL 18 or newer is required (uuidv7() is built in from 18); the shared container reports server_version_num $server_version_num."
printf 'Applying migrations and seed data to %s...\n' "$database_name"
pnpm exec turbo run db:seed --filter=@scos/persistence --output-logs=errors-only \
  || die 'Database migration or seeding failed; see the output above.'
# Match the reference launcher: increment from the preferred port until free.
# Parse .env as data; exported PORT takes precedence over the file.
PORT="$(node --env-file=.env --input-type=module <<'NODE'
import net from 'node:net';
const preferred = process.env.PORT ?? '3000';
if (!/^\d+$/.test(preferred) || +preferred < 1 || +preferred > 65535) {
  console.error('PORT must be an integer from 1 to 65535.');
  process.exit(1);
}
for (let port = Number(preferred); port <= 65535; port++) {
  const available = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', error => error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
    server.listen(port, () => server.close(() => resolve(true)));
  });
  if (available) { console.log(String(port)); process.exit(0); }
}
console.error('No available API port at or above the preferred port.');
process.exit(1);
NODE
)"
export PORT
printf '\nStarting API at http://localhost:%s (health: /health).\n' "$PORT"
printf 'Ctrl+C stops only this API. The shared container and worktree database remain available.\n\n'
# Development only: pass the generated database URL to the persistent Turbo task.
exec pnpm exec turbo run dev --filter=@scos/api --env-mode=loose
