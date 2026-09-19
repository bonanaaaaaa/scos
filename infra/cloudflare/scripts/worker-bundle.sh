#!/usr/bin/env bash
# Build the Worker bundle once and fingerprint it.
#
# Usage:
#   worker-bundle.sh build <outdir>    wrangler deploy --dry-run --outdir, then
#                                      the size budget and SHA256SUMS
#   worker-bundle.sh verify <outdir>   recheck SHA256SUMS before upload
#
# Run from the repository root after `pnpm install --frozen-lockfile` and the
# workspace build (@scos/persistence's workerd build). The budget matches
# apps/api/src/entrypoints/worker.bundle.test.ts: 8 MiB uncompressed (the
# Workers limit is 64 MiB) and 3 MiB gzip. The uploaded modules are worker.js
# and the .wasm file; the source map and README are not uploaded and not
# fingerprinted.
set -euo pipefail

readonly SIZE_BUDGET=$((8 * 1024 * 1024))
readonly COMPRESSED_BUDGET=$((3 * 1024 * 1024))

usage() {
  echo "usage: $0 build <outdir> | verify <outdir>" >&2
  exit 2
}
[[ $# -eq 2 ]] || usage
command=$1
outdir=$2
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$@"
  else
    shasum -a 256 "$@"
  fi
}

modules() {
  (cd "$outdir" && find . -maxdepth 1 -type f \( -name '*.js' -o -name '*.wasm' \) | sed 's|^\./||' | LC_ALL=C sort)
}

case $command in
  build)
    if [[ -e $outdir ]]; then
      echo "worker-bundle: $outdir already exists; build into a new directory." >&2
      exit 1
    fi
    mkdir -p "$outdir"
    outdir=$(cd "$outdir" && pwd)
    (
      cd "$repo_root/apps/api"
      CI=true WRANGLER_SEND_METRICS=false ./node_modules/.bin/wrangler deploy --dry-run \
        --outdir "$outdir"
    )
    total=0
    compressed=0
    while IFS= read -r file; do
      size=$(wc -c <"$outdir/$file" | tr -d ' ')
      gz=$(gzip -9 -c "$outdir/$file" | wc -c | tr -d ' ')
      total=$((total + size))
      compressed=$((compressed + gz))
    done < <(modules)
    echo "Bundle: $total bytes uncompressed (budget $SIZE_BUDGET), $compressed bytes gzip (budget $COMPRESSED_BUDGET)."
    if ((total >= SIZE_BUDGET || compressed >= COMPRESSED_BUDGET)); then
      echo "worker-bundle: the bundle exceeds its size budget." >&2
      exit 1
    fi
    if [[ $(modules | grep -c '\.wasm$') -ne 1 || ! -f $outdir/worker.js ]]; then
      echo "worker-bundle: expected worker.js and exactly one .wasm module." >&2
      exit 1
    fi
    files=()
    while IFS= read -r file; do
      files+=("$file")
    done < <(modules)
    (cd "$outdir" && sha256 "${files[@]}") >"$outdir/SHA256SUMS"
    cat "$outdir/SHA256SUMS"
    ;;
  verify)
    [[ -f $outdir/SHA256SUMS ]] || {
      echo "worker-bundle: no SHA256SUMS in $outdir" >&2
      exit 1
    }
    # Every uploadable module is listed, and every listed file matches.
    if [[ $(modules) != "$(awk '{print $2}' "$outdir/SHA256SUMS" | LC_ALL=C sort)" ]]; then
      echo "worker-bundle: the modules in $outdir differ from SHA256SUMS." >&2
      exit 1
    fi
    (cd "$outdir" && sha256 -c SHA256SUMS)
    ;;
  *)
    usage
    ;;
esac
