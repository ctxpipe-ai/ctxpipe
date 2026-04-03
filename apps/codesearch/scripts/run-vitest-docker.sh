#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
IMAGE="${CTXPIPE_CODESEARCH_TEST_IMAGE:-ctxpipe-codesearch:test}"

docker build -f "${ROOT}/apps/codesearch/Dockerfile" --target test -t "${IMAGE}" "${ROOT}"
exec docker run --rm "${IMAGE}" "$@"
