#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
IMAGE="${CTXPIPE_CODESEARCH_TEST_IMAGE:-ctxpipe-codesearch:test}"

# --trace <dir> writes <dir>/trace.json.gz (scripts/checks/README.md), and
# --records <dir> writes <dir>/records.ndjson (one result record for each test
# file). The container writes them to the mounted directories.
args=()
mount=()
selected=0
usage="Usage: run-vitest-docker.sh [--trace <dir>] [--records <dir>] [--node <file>] [--bun <file>]"
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
    --node | --bun)
      args+=("$1" "$2")
      selected=1
      ;;
    *) echo "$usage" >&2; exit 2 ;;
  esac
  shift 2
done
[ "${#args[@]}" -eq 0 ] || args=(pnpm run test:vitest "${args[@]}")

# The image has the platform of the Docker server: linux/arm64 on an Apple
# silicon laptop and on an arm64 CI runner, linux/amd64 on an amd64 machine.
# Docker runs another platform under emulation, which is slow, so none is forced.
case "$(docker info --format '{{.Architecture}}')" in
  aarch64 | arm64) platform=linux/arm64 ;;
  x86_64 | amd64) platform=linux/amd64 ;;
  *) echo "Unsupported Docker server architecture" >&2; exit 1 ;;
esac

# CI fills .release-cache with checksum-verified release files (fetch-releases.sh).
context=()
[ ! -d "${ROOT}/.release-cache" ] || context=(--build-context "releases=${ROOT}/.release-cache")
docker build --platform "${platform}" ${context[@]+"${context[@]}"} -f "${ROOT}/apps/codesearch/Dockerfile" --target test -t "${IMAGE}" "${ROOT}"
# The label of a test container (scripts/ci/test-containers.mjs). --init lets
# a signal stop the tests (Node as PID 1 ignores it), and the trap removes the
# container when a signal stops this script.
owner="${CTXPIPE_TEST_OWNER:-$(hostname)/$$}"
name="ctxpipe-codesearch-test-$$"
trap 'docker rm --force --volumes "${name}" >/dev/null 2>&1 || true' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker run --platform "${platform}" --init --rm --name "${name}" --label "ai.ctxpipe.test=${owner}" ${mount[@]+"${mount[@]}"} "${IMAGE}" ${args[@]+"${args[@]}"}
if [ "$selected" -eq 0 ]; then
  bash "${ROOT}/apps/codesearch/scripts/oom-simulation.sh" "${IMAGE}"
fi
