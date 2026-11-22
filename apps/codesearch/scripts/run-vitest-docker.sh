#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# The owner of the test container and of the test image: the label
# `ai.ctxpipe.test=<host>/<pid>` (scripts/ci/test-containers.mjs).
owner="${CTXPIPE_TEST_OWNER:-$(hostname)/$$}"
# Each run builds the image under a tag of its own, and removes that tag when
# it ends (CTX-1551): the image is about 12 GB, and runs of several agents
# share the Docker disk of a host. With one shared tag, each build left the
# image before it behind without a tag, and a run could start the image that
# another run had just built. An image that CTXPIPE_CODESEARCH_TEST_IMAGE
# names belongs to the caller, and stays.
if [ -n "${CTXPIPE_CODESEARCH_TEST_IMAGE:-}" ]; then
  IMAGE="${CTXPIPE_CODESEARCH_TEST_IMAGE}"
  own_image=0
else
  IMAGE="ctxpipe-codesearch:test-$(date +%s)-$$"
  own_image=1
fi

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
# The containers and test images of earlier runs on this host that were
# killed, so that they could not remove their own. Docker keeps an image that
# a container uses.
node "${ROOT}/scripts/ci/test-containers.mjs" remove-orphans || true
# --init lets a signal stop the tests (Node as PID 1 ignores it). The trap
# removes the container, and the image tag of this run, also when a signal
# stops this script. Docker refuses to remove an image that a container uses.
name="ctxpipe-codesearch-test-$$"
cleanup() {
  docker rm --force --volumes "${name}" >/dev/null 2>&1 || true
  [ "${own_image}" -eq 0 ] || docker image rm -- "${IMAGE}" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker build --platform "${platform}" ${context[@]+"${context[@]}"} --label "ai.ctxpipe.test=${owner}" -f "${ROOT}/apps/codesearch/Dockerfile" --target test -t "${IMAGE}" "${ROOT}"
docker run --platform "${platform}" --init --rm --name "${name}" --label "ai.ctxpipe.test=${owner}" ${mount[@]+"${mount[@]}"} "${IMAGE}" ${args[@]+"${args[@]}"}
if [ "$selected" -eq 0 ]; then
  bash "${ROOT}/apps/codesearch/scripts/oom-simulation.sh" "${IMAGE}"
fi
