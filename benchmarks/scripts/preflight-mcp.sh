#!/bin/bash
set -euo pipefail

if [[ -z "${CTXPIPE_MCP_URL:-}" ]]; then
  echo "CTXPIPE_MCP_URL is required"
  exit 1
fi

if [[ -z "${CTXPIPE_API_TOKEN:-}" ]]; then
  echo "CTXPIPE_API_TOKEN is required"
  exit 1
fi

tmp_body="$(mktemp)"
trap 'rm -f "$tmp_body"' EXIT

payload='{"jsonrpc":"2.0","id":"preflight","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"benchmark-preflight","version":"1.0.0"}}}'

status_code="$(
  curl -sS -o "$tmp_body" -w "%{http_code}" \
    -X POST "$CTXPIPE_MCP_URL" \
    -H "Authorization: Bearer ${CTXPIPE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "$payload"
)"

if [[ "$status_code" =~ ^2 ]]; then
  echo "ctxpipe MCP preflight succeeded for storage-decision with HTTP ${status_code}"
  exit 0
fi

echo "ctxpipe MCP preflight failed for storage-decision with HTTP ${status_code}"
echo "--- response ---"
cat "$tmp_body"
echo "----------------"
exit 1
