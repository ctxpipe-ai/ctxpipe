#!/usr/bin/env bash
# Download the pinned release files from release-assets.txt into OUT_DIR.
# Usage: fetch-releases.sh MANIFEST OUT_DIR [CACHE_DIR]
# A file in CACHE_DIR with the right checksum is copied, not downloaded.
# A download has a connect timeout, a stall check, a total timeout, and 3
# attempts, so the worst case per file is bounded (about 6 minutes). When the
# source stays down, the script fails with "Outside service unavailable".
set -euo pipefail
manifest=$1 out=$2 cache=${3:-}
mkdir -p "$out"
[ -z "$cache" ] || mkdir -p "$cache" 2>/dev/null || true
sha_ok() { echo "$1  $2" | sha256sum -c - >/dev/null 2>&1; }
while IFS=$'\t' read -r name sha url; do
  case "$name" in '' | '#'*) continue ;; esac
  if [ -n "$cache" ] && [ -f "$cache/$name" ] && sha_ok "$sha" "$cache/$name"; then
    cp "$cache/$name" "$out/$name"
    continue
  fi
  ok=0
  for attempt in 1 2 3; do
    if curl -fsSL --connect-timeout "${FETCH_CONNECT_TIMEOUT:-10}" \
      --speed-limit 1024 --speed-time "${FETCH_STALL_TIMEOUT:-30}" \
      --max-time "${FETCH_MAX_TIME:-120}" -o "$out/$name" "$url"; then
      ok=1
      break
    fi
    sleep $((attempt * ${FETCH_RETRY_DELAY:-5}))
  done
  if [ "$ok" != 1 ]; then
    echo "Outside service unavailable: cannot download $url after 3 attempts" >&2
    exit 1
  fi
  sha_ok "$sha" "$out/$name" || {
    echo "Checksum mismatch for $url (expected $sha)" >&2
    exit 1
  }
  # The cache can be read-only (a Docker bind mount); filling it is optional.
  [ -z "$cache" ] || cp "$out/$name" "$cache/$name" 2>/dev/null || true
done <"$manifest"
