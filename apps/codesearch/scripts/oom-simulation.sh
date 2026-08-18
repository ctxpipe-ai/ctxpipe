#!/usr/bin/env bash
set -euo pipefail

# Task-cgroup OOM probe for the default codesearch test suite.
# 32 MiB is below idle Bun RSS, so the *container* is SIGKILL'd — the product
# maps that shape to repository status `failed`, not `complete_with_issues`.
# Child-137 classification (API still alive) is covered by
# `src/routes/indexPhases.zoekt.test.ts` (HTTP `{ error }` body).

IMAGE="${1:?usage: oom-simulation.sh <image>}"
CONTAINER_NAME="ctxpipe-codesearch-oom-sim-$$"
MEMORY_LIMIT="32m"

cleanup() {
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

set +e
docker run \
  --name "${CONTAINER_NAME}" \
  --memory "${MEMORY_LIMIT}" \
  --memory-swap "${MEMORY_LIMIT}" \
  "${IMAGE}" \
  bun run /app/apps/codesearch/scripts/oom-simulation-entry.ts
status=$?
set -e

oom_killed="$(
  docker inspect --format '{{.State.OOMKilled}}' "${CONTAINER_NAME}" 2>/dev/null ||
    printf 'unknown'
)"
logs="$(docker logs "${CONTAINER_NAME}" 2>&1 || true)"

echo "oom-simulation: exit=${status} OOMKilled=${oom_killed}"
echo "${logs}"

if [[ "${oom_killed}" == "true" || "${status}" -eq 137 ]]; then
  echo "oom-simulation: PASS (task cgroup OOM → product status failed)"
  exit 0
fi

echo "oom-simulation: FAIL: expected OOMKilled or exit 137 for task-death probe" >&2
exit 1
