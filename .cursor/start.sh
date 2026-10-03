#!/usr/bin/env bash
# Cursor Cloud Agent: run after `install`, before agent tasks.
# See https://cursor.com/docs/cloud-agent/setup — "Startup commands" / "Running Docker".
set -euo pipefail

########################################################
# 1. Docker daemon
########################################################

docker_ok() { docker info >/dev/null 2>&1; }

# Socket may exist while the agent user is not yet in an effective docker group.
fix_docker_sock() {
  if [ -S /var/run/docker.sock ] && ! docker_ok; then
    sudo chmod 666 /var/run/docker.sock
  fi
}

if ! command -v docker >/dev/null 2>&1; then
  echo "cloud-agent: docker CLI not found. Rebuild the environment from .agents/Dockerfile (see Cursor Cloud setup docs)." >&2
  exit 1
fi

if ! docker_ok; then
  # Try the SysVinit service first (works when systemd/init registered it).
  sudo service docker start 2>/dev/null || true
  sleep 2
  fix_docker_sock

  if ! docker_ok; then
    # Only start a new daemon if nothing is listening yet.
    # Do not pass --storage-driver: .agents/Dockerfile writes it to
    # /etc/docker/daemon.json, and repeating the flag makes dockerd exit.
    if ! sudo docker info >/dev/null 2>&1; then
      sudo dockerd >/tmp/dockerd.log 2>&1 &
    else
      fix_docker_sock
    fi
  fi

  for _ in $(seq 1 45); do
    fix_docker_sock
    if docker_ok; then break; fi
    sleep 1
  done
fi

if ! docker_ok; then
  echo "cloud-agent: Docker daemon did not become ready in time." >&2
  if [ -f /tmp/dockerd.log ]; then
    echo "cloud-agent: last dockerd log lines:" >&2
    tail -n 40 /tmp/dockerd.log >&2 || true
  fi
  exit 1
fi

fix_docker_sock

########################################################
# 2. Backend .env.local from Cursor secrets
########################################################

ENV_LOCAL="apps/backend/.env.local"

if [ ! -f "$ENV_LOCAL" ] && [ -n "${AUTH_SECRET:-}" ]; then
  # Runtime URL is ctxpipe_app. Migrate still uses owner ctxpipe via db:migrate.
  # Defaults match docker-compose.yml infra profile (see docker-compose.env.example).
  PG_DEFAULT="postgresql://ctxpipe_app:ctxpipe@localhost:5433/ctxpipe" # pragma: allowlist secret
  REDIS_DEFAULT="redis://localhost:6379" # pragma: allowlist secret
  DB="${DATABASE_URL:-$PG_DEFAULT}"
  GRAPH="${GRAPH_DB_URI:-$REDIS_DEFAULT}"
  cat > "$ENV_LOCAL" <<EOF
DATABASE_URL=${DB}
GRAPH_DB_URI=${GRAPH}
AUTH_SECRET=${AUTH_SECRET}
AUTH_BASE_URL=http://localhost:3000
UI_PROXY_URL=http://localhost:3002
AUTH_ALLOWED_ORIGINS=http://localhost:3002,http://localhost:3000
EOF
  echo "cloud-agent: wrote $ENV_LOCAL from Cursor secrets."
fi
