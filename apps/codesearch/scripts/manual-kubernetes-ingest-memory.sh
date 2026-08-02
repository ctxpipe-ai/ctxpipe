#!/usr/bin/env bash
set -euo pipefail

# Manual, intentionally expensive memory regression gate. This is not part of
# the default test suite; run it after significant changes to repository ingest,
# Zoekt invocation, SCIP process orchestration, hot/cold pin management, or
# index artifact handling.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
IMAGE="ctxpipe-codesearch:kubernetes-memory-gate"
KUBERNETES_REPOSITORY="https://github.com/kubernetes/kubernetes.git"
KUBERNETES_SHA="0f29094e5b73085e3802ecc1298ecae13866bfe6" # v1.36.3

# Provisional MEMORY_MAX carried from the pre-hot/cold kubernetes@v1.36.3
# calibration (cgroup peak ~5158 MiB → 5670m). The gate now exercises empty
# zoekt-hot, cold-only shard writes, sequential Zoekt-then-SCIP, and
# GOMAXPROCS=2 / GOGC=50 — re-run this script where Docker is available and
# update MEMORY_MAX from the printed peak (+ ≤512 MiB headroom) before raising
# the ceiling. Do not treat 5670m as a new-model calibration.
MEMORY_MAX="5670m"

for command in docker git; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "manual-kubernetes-memory: required command not found: ${command}" >&2
    exit 1
  fi
done
if ! docker info >/dev/null 2>&1; then
  echo "manual-kubernetes-memory: Docker is not running" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ctxpipe-kubernetes-memory.XXXXXX")"
CONTAINER_NAME="ctxpipe-kubernetes-memory-$$"
CHECKOUT_DIR="${WORK_DIR}/data/repo-cache/org_manual/repo_kubernetes/checkouts/default"
SCIP_DIR="$(dirname "${CHECKOUT_DIR}")"
# Cold durable shards (zoekt-index writes here). Hot is a sibling directory of
# symlinks only — same derivation as apps/codesearch/src/config/paths.ts.
ZOEKT_DIR="${WORK_DIR}/data/zoekt-index"
ZOEKT_HOT_DIR="${WORK_DIR}/data/zoekt-hot"

cleanup() {
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT INT TERM

mkdir -p "${SCIP_DIR}" "${ZOEKT_DIR}" "${ZOEKT_HOT_DIR}"

# Seed an unrelated cold shard so the gate proves ingest does not copy/load it
# into hot (zoekt-webserver is not started here; Bun must not write real files
# into zoekt-hot during index).
printf 'unrelated-cold-shard\n' >"${ZOEKT_DIR}/other%2Frepo_v16.00000.zoekt"

git init --quiet "${CHECKOUT_DIR}"
git -C "${CHECKOUT_DIR}" remote add origin "${KUBERNETES_REPOSITORY}"
git -C "${CHECKOUT_DIR}" fetch --quiet --depth=1 origin "${KUBERNETES_SHA}"
git -C "${CHECKOUT_DIR}" checkout --quiet --detach FETCH_HEAD
actual_sha="$(git -C "${CHECKOUT_DIR}" rev-parse HEAD)"
if [[ "${actual_sha}" != "${KUBERNETES_SHA}" ]]; then
  echo "manual-kubernetes-memory: expected ${KUBERNETES_SHA}, got ${actual_sha}" >&2
  exit 1
fi

# Keep the service's refresh fetch shallow and narrowly scoped to the stable tag.
git -C "${CHECKOUT_DIR}" config remote.origin.fetch \
  "+refs/tags/v1.36.3:refs/tags/v1.36.3"

cat >"${WORK_DIR}/run-ingest.ts" <<EOF
import { cloneAndIndexRepository } from "/app/apps/codesearch/src/domain/indexing/service.ts"
import { SCIP_INDEXER_CONCURRENCY } from "/app/apps/codesearch/src/domain/indexing/indexerPool.ts"
import { withIndexerGoLimits } from "/app/apps/codesearch/src/domain/indexing/indexerChildEnv.ts"

const noOpDb = {
  update: () => ({
    set: () => ({
      where: async () => undefined,
    }),
  }),
}

if (SCIP_INDEXER_CONCURRENCY !== 2) {
  throw new Error(\`Memory gate requires SCIP_INDEXER_CONCURRENCY===2; configured \${SCIP_INDEXER_CONCURRENCY}\`)
}

const goEnv = withIndexerGoLimits()
if (goEnv.GOMAXPROCS !== "2" || goEnv.GOGC !== "50") {
  throw new Error(
    \`Memory gate requires default indexer GOMAXPROCS=2 GOGC=50; got GOMAXPROCS=\${goEnv.GOMAXPROCS} GOGC=\${goEnv.GOGC}\`,
  )
}

const result = await cloneAndIndexRepository({
  db: noOpDb as never,
  orgId: "org_manual",
  repoId: "repo_kubernetes",
  repoGitUrl: "${KUBERNETES_REPOSITORY}",
  clonePath: "/gate/data/repo-cache/org_manual/repo_kubernetes/checkouts/default",
  scipIndexPath: "/gate/data/repo-cache/org_manual/repo_kubernetes/checkouts/default.scip",
  zoektRepoId: 1,
  repoName: "kubernetes/kubernetes",
  repoUrl: "${KUBERNETES_REPOSITORY}",
  targetHash: "${KUBERNETES_SHA}",
})

if (result.targetHash !== "${KUBERNETES_SHA}") {
  throw new Error(\`Indexed unexpected commit: \${result.targetHash}\`)
}
console.log(JSON.stringify(result))
EOF

cat >"${WORK_DIR}/run-with-memory-sampler.sh" <<'EOF'
#!/usr/bin/env bash
set -uo pipefail

read_memory_bytes() {
  if [[ -r /sys/fs/cgroup/memory.current ]]; then
    read -r memory_bytes </sys/fs/cgroup/memory.current
  elif [[ -r /sys/fs/cgroup/memory/memory.usage_in_bytes ]]; then
    read -r memory_bytes </sys/fs/cgroup/memory/memory.usage_in_bytes
  else
    memory_bytes=0
  fi
  printf '%s\n' "${memory_bytes}"
}

bun run /gate/run-ingest.ts &
ingest_pid=$!
sampled_peak=0
while kill -0 "${ingest_pid}" 2>/dev/null; do
  current="$(read_memory_bytes)"
  if [[ "${current}" =~ ^[0-9]+$ ]] && (( current > sampled_peak )); then
    sampled_peak="${current}"
  fi
  sleep 1
done

wait "${ingest_pid}"
status=$?

kernel_peak=0
if [[ -r /sys/fs/cgroup/memory.peak ]]; then
  read -r kernel_peak </sys/fs/cgroup/memory.peak
elif [[ -r /sys/fs/cgroup/memory/memory.max_usage_in_bytes ]]; then
  read -r kernel_peak </sys/fs/cgroup/memory/memory.max_usage_in_bytes
fi
if [[ "${kernel_peak}" =~ ^[0-9]+$ ]] && (( kernel_peak > sampled_peak )); then
  sampled_peak="${kernel_peak}"
fi

printf '%s\n' "${sampled_peak}" >/gate/peak-memory-bytes
printf 'manual-kubernetes-memory: measured cgroup peak: %s bytes\n' "${sampled_peak}"
exit "${status}"
EOF
chmod +x "${WORK_DIR}/run-with-memory-sampler.sh"

echo "manual-kubernetes-memory: building ${IMAGE}"
docker build \
  -f "${ROOT}/apps/codesearch/Dockerfile" \
  -t "${IMAGE}" \
  "${ROOT}"

echo "manual-kubernetes-memory: indexing ${KUBERNETES_SHA} with ${MEMORY_MAX} limit (cold=${ZOEKT_DIR}, hot=${ZOEKT_HOT_DIR})"
set +e
docker run \
  --name "${CONTAINER_NAME}" \
  --memory "${MEMORY_MAX}" \
  --memory-swap "${MEMORY_MAX}" \
  --mount "type=bind,src=${WORK_DIR},dst=/gate" \
  -e ZOEKT_INDEX_DIR=/gate/data/zoekt-index \
  -e REPO_CACHE_DIR=/gate/data/repo-cache \
  --entrypoint /gate/run-with-memory-sampler.sh \
  "${IMAGE}"
status=$?
set -e

oom_killed="$(
  docker inspect --format '{{.State.OOMKilled}}' "${CONTAINER_NAME}" 2>/dev/null ||
    printf 'unknown'
)"
if [[ "${status}" -eq 137 || "${oom_killed}" == "true" ]]; then
  echo "manual-kubernetes-memory: FAIL: ingest was OOM-killed (exit ${status})" >&2
  exit 1
fi
if [[ "${status}" -ne 0 ]]; then
  echo "manual-kubernetes-memory: FAIL: ingest exited ${status}" >&2
  exit "${status}"
fi

merged_scip="${SCIP_DIR}/default.scip"
if [[ ! -s "${merged_scip}" ]]; then
  echo "manual-kubernetes-memory: FAIL: missing non-empty ${merged_scip}" >&2
  exit 1
fi

shopt -s nullglob
scip_shards=("${SCIP_DIR}"/default.*.scip)
if (( ${#scip_shards[@]} == 0 )); then
  echo "manual-kubernetes-memory: FAIL: no language SCIP shards under ${SCIP_DIR}" >&2
  exit 1
fi
go_shard="${SCIP_DIR}/default.go.scip"
if [[ ! -s "${go_shard}" ]]; then
  echo "manual-kubernetes-memory: FAIL: expected non-empty Go shard ${go_shard}" >&2
  exit 1
fi
for shard in "${scip_shards[@]}"; do
  if [[ ! -s "${shard}" ]]; then
    echo "manual-kubernetes-memory: FAIL: empty SCIP shard ${shard}" >&2
    exit 1
  fi
done

if ! compgen -G "${ZOEKT_DIR}/kubernetes%2Fkubernetes_*.zoekt" >/dev/null; then
  echo "manual-kubernetes-memory: FAIL: no kubernetes Zoekt shards under ${ZOEKT_DIR}" >&2
  exit 1
fi

# Ingest must not pin/search, so hot should stay empty (only cold grows).
# Use find -P so dangling symlinks still count as non-empty.
hot_count="$(find -P "${ZOEKT_HOT_DIR}" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')"
if [[ "${hot_count}" != "0" ]]; then
  echo "manual-kubernetes-memory: FAIL: expected empty hot dir, found ${hot_count} entr(y/ies)" >&2
  find -P "${ZOEKT_HOT_DIR}" -mindepth 1 -maxdepth 1 -print >&2 || true
  exit 1
fi

# Unrelated cold shard must still be present (not deleted) and not copied to hot.
if [[ ! -f "${ZOEKT_DIR}/other%2Frepo_v16.00000.zoekt" ]]; then
  echo "manual-kubernetes-memory: FAIL: unrelated cold shard was removed" >&2
  exit 1
fi
if [[ -e "${ZOEKT_HOT_DIR}/other%2Frepo_v16.00000.zoekt" ]]; then
  echo "manual-kubernetes-memory: FAIL: unrelated cold shard appeared in hot" >&2
  exit 1
fi

peak_bytes="$(<"${WORK_DIR}/peak-memory-bytes")"
echo "manual-kubernetes-memory: PASS: exit 0, Zoekt cold index and ${#scip_shards[@]} SCIP shard(s); hot empty"
echo "manual-kubernetes-memory: peak=${peak_bytes} bytes (ceiling MEMORY_MAX=${MEMORY_MAX})"
