#!/usr/bin/env bash
set -euo pipefail

# Tiny-cgroup OOM simulation for the default codesearch test suite.
# Uses the same image as Vitest; 32 MiB is intentionally below idle+index RSS.

IMAGE="${1:?usage: oom-simulation.sh <image>}"
CONTAINER_NAME="ctxpipe-codesearch-oom-sim-$$"
MEMORY_LIMIT="32m"
CANONICAL="Codebase didn't fit available memory"

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
  echo "oom-simulation: PASS (task cgroup OOM)"
  exit 0
fi

if printf '%s' "${logs}" | grep -Fq "${CANONICAL}"; then
  echo "oom-simulation: PASS (child classified as memory-fit)"
  exit 0
fi

echo "oom-simulation: FAIL: expected OOMKilled, exit 137, or ${CANONICAL}" >&2
exit 1
