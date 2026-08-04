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

# Forward SIGTERM/INT to both processes
trap 'echo "Shutting down..."; kill $ZOEKT_PID 2>/dev/null; exit 0' TERM INT

echo "Starting codesearch API on :${PORT:-3001}"
bun run /app/apps/codesearch/src/server.ts
