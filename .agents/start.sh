#!/usr/bin/env bash
# Cursor Cloud Agent: run after `install`, before agent tasks.
# See https://cursor.com/docs/cloud-agent/setup — "Startup commands" / "Running Docker".
set -euo pipefail

docker_info() {
  docker info >/dev/null 2>&1 || sudo docker info >/dev/null 2>&1
}

if ! command -v docker >/dev/null 2>&1; then
  echo "cloud-agent: docker CLI not found. Rebuild the environment from .agents/Dockerfile (see Cursor Cloud setup docs)." >&2
  exit 1
fi

sudo service docker start || true

# Wait for the daemon (first boot can be slow inside nested containers).
for _ in $(seq 1 45); do
  if docker_info; then
    exit 0
  fi
  sleep 1
done

echo "cloud-agent: Docker daemon did not become ready in time." >&2
exit 1
