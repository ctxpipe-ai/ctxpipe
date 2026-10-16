#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
IMAGE="${CTXPIPE_CODESEARCH_TEST_IMAGE:-ctxpipe-codesearch:test}"

# CI fills .release-cache with checksum-verified release files (fetch-releases.sh).
context=()
[ ! -d "${ROOT}/.release-cache" ] || context=(--build-context "releases=${ROOT}/.release-cache")
docker build --platform linux/amd64 "${context[@]}" -f "${ROOT}/apps/codesearch/Dockerfile" --target test -t "${IMAGE}" "${ROOT}"
docker run --platform linux/amd64 --rm "${IMAGE}" "$@"
bash "${ROOT}/apps/codesearch/scripts/oom-simulation.sh" "${IMAGE}"
