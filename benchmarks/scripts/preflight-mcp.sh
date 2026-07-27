#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${CTXPIPE_MCP_URL:-}" ]]; then
  echo "CTXPIPE_MCP_URL is required for ctxpipe benchmark arm."
  exit 1
fi

if [[ -z "${CTXPIPE_API_TOKEN:-}" ]]; then
  echo "CTXPIPE_API_TOKEN is required for ctxpipe benchmark arm."
  exit 1
fi

echo "ctxpipe MCP preflight passed."
