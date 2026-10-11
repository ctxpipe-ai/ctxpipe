#!/usr/bin/env bash
# Apply the custom Langfuse model prices in models.json. A missing model is
# created. A model whose pattern or prices changed gets a new definition
# with startDate now, which Langfuse uses for new generations. Nothing is
# deleted, so a second run changes nothing.
# Usage: LANGFUSE_AUTH_STRING=<base64 pk:sk> ./apply-models.sh
set -euo pipefail
base="https://langfuse.ctxpipe.ai"
auth="Authorization: Basic ${LANGFUSE_AUTH_STRING:?set LANGFUSE_AUTH_STRING}"
dir="$(cd "$(dirname "$0")" && pwd)"

existing="[]"
page=1
while :; do
  body="$(curl -fsS -H "$auth" "$base/api/public/models?page=$page&limit=100")"
  existing="$(jq -c --argjson add "$(jq -c '.data' <<<"$body")" '. + $add' <<<"$existing")"
  [ "$page" -ge "$(jq -r '.meta.totalPages' <<<"$body")" ] && break
  page=$((page + 1))
done

jq -c '.[]' "$dir/models.json" | while read -r model; do
  name="$(jq -r '.modelName' <<<"$model")"
  # The newest custom definition of this name, as the fields models.json sets.
  current="$(jq -c --arg name "$name" '
    [.[] | select(.modelName == $name and (.isLangfuseManaged | not))]
    | sort_by(.startDate // "") | last
    | if . == null then null
      else {modelName, matchPattern, unit, inputPrice, outputPrice} end
  ' <<<"$existing")"
  if [ "$current" = "$(jq -c '{modelName, matchPattern, unit, inputPrice, outputPrice}' <<<"$model")" ]; then
    echo "same $name"
    continue
  fi
  if [ "$current" = "null" ]; then
    payload="$model"
    action="created"
  else
    payload="$(jq -c --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '. + {startDate: $now}' <<<"$model")"
    action="updated"
  fi
  curl -fsS -X POST -H "$auth" -H "content-type: application/json" \
    -d "$payload" "$base/api/public/models" >/dev/null
  echo "$action $name"
done
