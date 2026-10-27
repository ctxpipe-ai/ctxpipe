#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
IMAGE="${CTXPIPE_CODESEARCH_TEST_IMAGE:-ctxpipe-codesearch:test}"

# --trace <dir> writes <dir>/trace.json.gz (scripts/checks/README.md), and
# --records <dir> writes <dir>/records.ndjson (one result record for each test
# file). The container writes them to the mounted directories.
args=()
mount=()
usage="Usage: run-vitest-docker.sh [--trace <dir>] [--records <dir>]"
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || { echo "$usage" >&2; exit 2; }
  case "$1" in
    --trace)
      mkdir -p "$2"
      mount+=(-v "$(cd "$2" && pwd):/trace")
      args+=(--trace /trace --commit "$(git -C "${ROOT}" rev-parse HEAD)")
      ;;
    --records)
      mkdir -p "$2"
      mount+=(-v "$(cd "$2" && pwd):/records")
      args+=(--records /records)
      ;;
    *) echo "$usage" >&2; exit 2 ;;
  esac
  shift 2
done
[ "${#args[@]}" -eq 0 ] || args=(pnpm run test:vitest "${args[@]}")

# CI fills .release-cache with checksum-verified release files (fetch-releases.sh).
context=()
[ ! -d "${ROOT}/.release-cache" ] || context=(--build-context "releases=${ROOT}/.release-cache")
docker build --platform linux/amd64 ${context[@]+"${context[@]}"} -f "${ROOT}/apps/codesearch/Dockerfile" --target test -t "${IMAGE}" "${ROOT}"
docker run --platform linux/amd64 --rm ${mount[@]+"${mount[@]}"} "${IMAGE}" ${args[@]+"${args[@]}"}
bash "${ROOT}/apps/codesearch/scripts/oom-simulation.sh" "${IMAGE}"
