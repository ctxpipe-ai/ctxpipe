#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
IMAGE="${CTXPIPE_CODESEARCH_TEST_IMAGE:-ctxpipe-codesearch:test}"

docker build --platform linux/amd64 -f "${ROOT}/apps/codesearch/Dockerfile" --target test -t "${IMAGE}" "${ROOT}"
docker run --platform linux/amd64 --rm "${IMAGE}" "$@"
bash "${ROOT}/apps/codesearch/scripts/oom-simulation.sh" "${IMAGE}"
