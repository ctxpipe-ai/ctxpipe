#!/usr/bin/env bash
# Create the custom Langfuse model prices in models.json. A model name that
# Langfuse already has is skipped, so a second run changes nothing.
# Usage: LANGFUSE_AUTH_STRING=<base64 pk:sk> ./apply-models.sh
set -euo pipefail
base="${LANGFUSE_URL:-https://langfuse.ctxpipe.ai}"
auth="Authorization: Basic ${LANGFUSE_AUTH_STRING:?set LANGFUSE_AUTH_STRING}"
dir="$(cd "$(dirname "$0")" && pwd)"

existing=""
page=1
while :; do
  body="$(curl -fsS -H "$auth" "$base/api/public/models?page=$page&limit=100")"
  existing+="$(jq -r '.data[].modelName' <<<"$body")"$'\n'
  [ "$page" -ge "$(jq -r '.meta.totalPages' <<<"$body")" ] && break
  page=$((page + 1))
done

jq -c '.[]' "$dir/models.json" | while read -r model; do
  name="$(jq -r '.modelName' <<<"$model")"
  if grep -qxF "$name" <<<"$existing"; then
    echo "skip $name"
    continue
  fi
  curl -fsS -X POST -H "$auth" -H "content-type: application/json" \
    -d "$model" "$base/api/public/models" >/dev/null
  echo "created $name"
done
