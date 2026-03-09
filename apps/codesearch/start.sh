#!/bin/sh
set -e

ZOEKT_INDEX="${ZOEKT_INDEX_DIR:-/data/zoekt-index}"

echo "Starting zoekt-webserver on :6070 (index: $ZOEKT_INDEX)"
zoekt-webserver -index "$ZOEKT_INDEX" -rpc -listen :6070 &
ZOEKT_PID=$!

# Forward SIGTERM/INT to both processes
trap 'echo "Shutting down..."; kill $ZOEKT_PID 2>/dev/null; exit 0' TERM INT

echo "Starting codesearch API on :${PORT:-3001}"
bun run /app/apps/codesearch/src/server.ts
