#!/usr/bin/env bash
# Start ngrok tunnel to app.ctxpipe using portless
# Usage: ./scripts/ngrok-tunnel.sh [domain]
# When a domain is provided, ngrok uses that reserved domain. Otherwise it uses
# a random session URL from the authenticated ngrok account.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

sleep 10

# Optional ngrok domain (can be provided via argument or NGROK_DOMAIN env).
NGROK_DOMAIN="${1:-${NGROK_DOMAIN:-}}"
if [[ -n "$NGROK_DOMAIN" ]]; then
  # Strip https:// prefix if present.
  NGROK_DOMAIN="${NGROK_DOMAIN#https://}"
fi

# Public URL is https://app.ctxpipe.localhost (no port). Ngrok must target the internal backend
# port shown after `->` in `portless list` (e.g. localhost:4516).
# Plain text: strip ANSI when piped if FORCE_COLOR is set; match only the target after `->`.
LOCAL_PORT="$(
  set +o pipefail
  NO_COLOR=1 FORCE_COLOR=0 pnpm exec portless list 2>/dev/null |
    grep -F 'app.ctxpipe' |
    head -n1 |
    perl -pe 's/\e\[[0-9;]*m//g' 2>/dev/null |
    sed -nE 's/.*->[[:space:]]*localhost:([0-9]+).*/\1/p'
)"

if [[ -z "$LOCAL_PORT" ]]; then
  echo "Error: Could not read internal port for app.ctxpipe from \`pnpm exec portless list\` (repo root)" >&2
  echo "Make sure portless is running (e.g. pnpm dev from the repo root)" >&2
  exit 1
fi

echo "Portless backend (internal): localhost:$LOCAL_PORT"
if [[ -n "$NGROK_DOMAIN" ]]; then
  echo "Tunneling localhost:$LOCAL_PORT -> https://$NGROK_DOMAIN"
else
  echo "Tunneling localhost:$LOCAL_PORT with an ngrok-assigned URL"
fi
echo ""

# Check if ngrok is installed
if ! command -v ngrok &> /dev/null; then
  echo "Error: ngrok is not installed" >&2
  echo "Install from: https://ngrok.com/download" >&2
  exit 1
fi

if [[ -n "$NGROK_DOMAIN" ]]; then
  exec ngrok http --url="$NGROK_DOMAIN" "$LOCAL_PORT"
fi

exec ngrok http "$LOCAL_PORT"
