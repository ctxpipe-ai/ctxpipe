#!/usr/bin/env bash
# Start ngrok tunnel to app.ctxpipe using portless
# Usage: ./scripts/ngrok-tunnel.sh [domain]
# Default domain: janel-chordamesodermic-jodee.ngrok-free.dev

set -euo pipefail

# Default ngrok domain (can be overridden via argument or NGROK_DOMAIN env)
DEFAULT_DOMAIN="janel-chordamesodermic-jodee.ngrok-free.dev"
NGROK_DOMAIN="${1:-${NGROK_DOMAIN:-$DEFAULT_DOMAIN}}"

# Strip https:// prefix if present
NGROK_DOMAIN="${NGROK_DOMAIN#https://}"

# `portless get app.ctxpipe` returns the HTTPS proxy URL (e.g. :1355). Ngrok must target the
# internal backend port shown after `->` in `portless list` (e.g. localhost:4516).
LOCAL_PORT="$(
  set +o pipefail
  pnpm portless list 2>/dev/null |
    grep -F 'app.ctxpipe' |
    head -n1 |
    sed -nE 's/.*->[[:space:]]*localhost:([0-9]+).*/\1/p'
)"

if [[ -z "$LOCAL_PORT" ]]; then
  echo "Error: Could not read internal port for app.ctxpipe from \`pnpm portless list\`" >&2
  echo "Make sure portless is running (e.g. pnpm dev from the repo root)" >&2
  exit 1
fi

echo "Portless backend (internal): localhost:$LOCAL_PORT"
echo "Tunneling localhost:$LOCAL_PORT -> https://$NGROK_DOMAIN"
echo ""

# Check if ngrok is installed
if ! command -v ngrok &> /dev/null; then
  echo "Error: ngrok is not installed" >&2
  echo "Install from: https://ngrok.com/download" >&2
  exit 1
fi

# Start ngrok with custom domain
exec ngrok http --domain="$NGROK_DOMAIN" "$LOCAL_PORT"
