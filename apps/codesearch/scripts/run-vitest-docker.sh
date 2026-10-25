#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
IMAGE="${CTXPIPE_CODESEARCH_TEST_IMAGE:-ctxpipe-codesearch:test}"

# --trace <dir> writes <dir>/trace.json.gz (scripts/checks/README.md): the
# container writes the trace to <dir>, which is mounted at /trace.
args=("$@")
mount=()
if [ "${1:-}" = "--trace" ]; then
  [ "$#" -eq 2 ] || { echo "Usage: run-vitest-docker.sh [--trace <dir>]" >&2; exit 2; }
  mkdir -p "$2"
  mount=(-v "$(cd "$2" && pwd):/trace")
  args=(pnpm run test:vitest --trace /trace --commit "$(git -C "${ROOT}" rev-parse HEAD)")
fi

# CI fills .release-cache with checksum-verified release files (fetch-releases.sh).
context=()
[ ! -d "${ROOT}/.release-cache" ] || context=(--build-context "releases=${ROOT}/.release-cache")
docker build --platform linux/amd64 ${context[@]+"${context[@]}"} -f "${ROOT}/apps/codesearch/Dockerfile" --target test -t "${IMAGE}" "${ROOT}"
docker run --platform linux/amd64 --rm ${mount[@]+"${mount[@]}"} "${IMAGE}" ${args[@]+"${args[@]}"}
bash "${ROOT}/apps/codesearch/scripts/oom-simulation.sh" "${IMAGE}"
