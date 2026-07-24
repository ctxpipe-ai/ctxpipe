#!/usr/bin/env bash
# Start codesearch in Docker (same image as deploy: start.sh runs zoekt-webserver + Bun API).
# Publishes container port 3001 to a random host port, sets CODESEARCH_URL for backend/worker.
# Intended to be sourced from scripts/dev-apps.sh (same shell — exports and EXIT trap apply).
# Rebuilds when Dockerfile COPY inputs change (label ctxpipe.codesearch.source-hash).
# Force rebuild: CTXPIPE_CODESEARCH_REBUILD=1 pnpm dev

set -euo pipefail

# Fingerprint of Dockerfile COPY inputs; stored on the image label ctxpipe.codesearch.source-hash.
codesearch_source_hash() {
  local root="$1"
  local hash_cmd aggregate_cmd
  if command -v shasum >/dev/null 2>&1; then
    hash_cmd=(shasum -a 256)
    aggregate_cmd=(shasum -a 256)
  else
    hash_cmd=(sha256sum)
    aggregate_cmd=(sha256sum)
  fi

  list_codesearch_build_inputs "$root" | while IFS= read -r f; do
    [[ -n "$f" && -f "$root/$f" ]] || continue
    "${hash_cmd[@]}" "$root/$f"
  done | "${aggregate_cmd[@]}" | awk '{print substr($1, 1, 12)}'
}

list_codesearch_build_inputs() {
  local root="$1"
  if git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$root" ls-files \
      apps/codesearch \
      package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json \
      patches 2>/dev/null | LC_ALL=C sort -u
    return
  fi

  (
    cd "$root"
    find apps/codesearch -path 'apps/codesearch/.data' -prune -o -type f -print
    for f in package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json; do
      [[ -f "$f" ]] && printf '%s\n' "$f"
    done
    if [[ -d patches ]]; then find patches -type f; fi
  ) | LC_ALL=C sort -u
}

if ! docker info >/dev/null 2>&1; then
  echo "codesearch-docker-dev: Docker is not running (required for codesearch during pnpm dev)." >&2
  exit 1
fi

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
IMAGE="${CTXPIPE_CODESEARCH_IMAGE:-ctxpipe-codesearch:dev}"

if command -v shasum >/dev/null 2>&1; then
  _HASH="$(printf '%s' "$REPO_ROOT" | shasum -a 256 | cut -c1-12)"
else
  _HASH="$(printf '%s' "$REPO_ROOT" | sha256sum | cut -c1-12)"
fi
CONTAINER_NAME="ctxpipe-codesearch-${_HASH}"

CODESEARCH_DATA="$REPO_ROOT/apps/codesearch/.data"
mkdir -p "$CODESEARCH_DATA/zoekt-index" "$CODESEARCH_DATA/repo-cache"

ENV_FILE="$REPO_ROOT/apps/backend/.env.local"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
fi

if [[ -z "${AUTH_SECRET:-}" ]] || [[ ${#AUTH_SECRET} -lt 32 ]]; then
  echo "codesearch-docker-dev: set AUTH_SECRET (>= 32 chars) in apps/backend/.env.local" >&2
  exit 1
fi

PG_HOST_PORT="${CTXPIPE_POSTGRES_HOST_PORT:-5433}"
DB_URL="${DATABASE_URL:-postgresql://ctxpipe:ctxpipe@localhost:${PG_HOST_PORT}/ctxpipe}"
DB_FOR_CONTAINER="${DB_URL//localhost/host.docker.internal}"
DB_FOR_CONTAINER="${DB_FOR_CONTAINER//127.0.0.1/host.docker.internal}"

DOCKER_ARGS=(
  -d --rm
  --name "$CONTAINER_NAME"
  -p 0:3001
  -v "$CODESEARCH_DATA/zoekt-index:/data/zoekt-index"
  -v "$CODESEARCH_DATA/repo-cache:/data/repo-cache"
  -e "DATABASE_URL=$DB_FOR_CONTAINER"
  -e "AUTH_SECRET=$AUTH_SECRET"
  -e "ZOEKT_WEBSERVER_URL=http://127.0.0.1:6070"
  -e "PORT=3001"
  -e "NODE_ENV=development"
)
if [[ -n "${AUTH_ISSUER:-}" ]]; then
  DOCKER_ARGS+=(-e "AUTH_ISSUER=$AUTH_ISSUER")
fi
if [[ -n "${AUTH_TOKEN_AUDIENCE_CODESEARCH:-}" ]]; then
  DOCKER_ARGS+=(-e "AUTH_TOKEN_AUDIENCE_CODESEARCH=$AUTH_TOKEN_AUDIENCE_CODESEARCH")
fi

if [[ "$(uname -s)" == "Linux" ]]; then
  DOCKER_ARGS+=(--add-host=host.docker.internal:host-gateway)
fi

codesearch_docker_cleanup() {
  docker stop "$CONTAINER_NAME" 2>/dev/null || true
}
trap codesearch_docker_cleanup EXIT INT TERM

docker stop "$CONTAINER_NAME" 2>/dev/null || true

SOURCE_HASH="$(codesearch_source_hash "$REPO_ROOT")"
need_build=0
if [[ "${CTXPIPE_CODESEARCH_REBUILD:-}" == 1 ]]; then
  need_build=1
elif ! docker image inspect "$IMAGE" &>/dev/null; then
  need_build=1
else
  built_hash="$(
    docker image inspect --format '{{ index .Config.Labels "ctxpipe.codesearch.source-hash" }}' "$IMAGE" 2>/dev/null || true
  )"
  if [[ "$built_hash" != "$SOURCE_HASH" ]]; then
    need_build=1
  fi
fi

if [[ "$need_build" == 1 ]]; then
  echo "codesearch-docker-dev: building $IMAGE (source $SOURCE_HASH)…" >&2
  docker build \
    -f "$REPO_ROOT/apps/codesearch/Dockerfile" \
    --label "ctxpipe.codesearch.source-hash=$SOURCE_HASH" \
    -t "$IMAGE" \
    "$REPO_ROOT"
else
  echo "codesearch-docker-dev: image $IMAGE up to date (source $SOURCE_HASH)" >&2
fi

docker run "${DOCKER_ARGS[@]}" "$IMAGE"

# Wait for bind
for _ in $(seq 1 30); do
  if docker port "$CONTAINER_NAME" 3001 &>/dev/null; then
    break
  fi
  sleep 0.2
done

HOST_PORT="$(docker port "$CONTAINER_NAME" 3001 | head -1 | awk -F: '{print $NF}')"
export CODESEARCH_URL="http://127.0.0.1:${HOST_PORT}"
echo "codesearch-docker-dev: CODESEARCH_URL=$CODESEARCH_URL (container $CONTAINER_NAME)" >&2
