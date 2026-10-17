#!/usr/bin/env bash
# Smoke test for a PR preview UI. Usage: smoke-preview-ui.sh <backend-url> [production-url]
# Passes when the preview serves a module bundle that differs from production.
set -euo pipefail

backend_url="${1:?usage: smoke-preview-ui.sh <backend-url> [production-url]}"
prod_url="${2:-https://app.ctxpipe.ai}"
deadline=$(( $(date +%s) + 180 ))

bundle_path() {
  grep -aoE '<script type="module"[^>]* src="/assets/[A-Za-z0-9._-]+\.js"' \
    | grep -oE '/assets/[A-Za-z0-9._-]+\.js' | head -1 || true
}

echo "Smoke-testing preview UI via $backend_url (bundle must differ from production)"
while true; do
  html="$(curl -fsS --compressed --max-time 25 "$backend_url/" || true)"
  js_path="$(printf '%s' "$html" | bundle_path)"
  prod_html="$(curl -fsS --compressed --max-time 25 "$prod_url/" || true)"
  prod_js_path="$(printf '%s' "$prod_html" | bundle_path)"
  if [[ -n "$js_path" && -n "$prod_js_path" && "$js_path" == "$prod_js_path" ]]; then
    echo "Preview UI bundle matches production ($js_path); still serving main" >&2
  elif [[ -n "$js_path" ]]; then
    echo "Preview UI smoke test passed (js=$js_path, production js=${prod_js_path:-unknown})"
    exit 0
  else
    echo "Preview UI HTML had no module bundle yet" >&2
  fi
  if (( $(date +%s) >= deadline )); then
    echo "ERROR: preview is not serving its own UI at $backend_url" >&2
    echo "preview js=${js_path:-none} production js=${prod_js_path:-none}" >&2
    printf '%s\n' "$html" | head -c 500 >&2 || true
    exit 1
  fi
  sleep 8
done
