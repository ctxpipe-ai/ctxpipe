#!/bin/sh
set -e

# Cold durable shards (zoekt-index writes here). Hot is a sibling directory of
# symlinks only — same derivation as apps/codesearch/src/config/paths.ts
# (no separate env var for hot).
ZOEKT_INDEX="${ZOEKT_INDEX_DIR:-/data/zoekt-index}"
ZOEKT_HOT="$(dirname "$ZOEKT_INDEX")/zoekt-hot"

mkdir -p "$ZOEKT_INDEX"
# Restart with zero loaded shards so zoekt-webserver does not inherit stale pins.
rm -rf "$ZOEKT_HOT"
mkdir -p "$ZOEKT_HOT"

echo "Starting zoekt-webserver on :6070 (hot index: $ZOEKT_HOT, cold: $ZOEKT_INDEX)"
zoekt-webserver -index "$ZOEKT_HOT" -rpc -listen :6070 &
ZOEKT_PID=$!

echo "Starting codesearch API on :${PORT:-3001}"
bun run /app/apps/codesearch/src/server.ts &
BUN_PID=$!

# Railway stops the container with SIGTERM. The shell is PID 1 here, so forward
# the signal and wait for bun to run shutdownOtel before exiting.
shutdown() {
  echo "Shutting down..."
  kill -TERM "$ZOEKT_PID" 2>/dev/null || true
  kill -TERM "$BUN_PID" 2>/dev/null || true
  wait "$BUN_PID" 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

wait "$BUN_PID"
STATUS=$?
kill -TERM "$ZOEKT_PID" 2>/dev/null || true
exit "$STATUS"
