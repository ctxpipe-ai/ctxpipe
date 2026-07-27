#!/bin/bash
set -euo pipefail

LOCKFILE="${1:-benchmarks/fixtures/storage-decision-v1.lock.json}"

primary_sha="$(git ls-remote https://github.com/grafana/loki HEAD | awk '{print $1}')"
tempo_sha="$(git ls-remote https://github.com/grafana/tempo HEAD | awk '{print $1}')"
mimir_sha="$(git ls-remote https://github.com/grafana/mimir HEAD | awk '{print $1}')"

tmp_lock="$(mktemp)"
trap 'rm -f "$tmp_lock"' EXIT

jq \
  --arg primary "$primary_sha" \
  --arg tempo "$tempo_sha" \
  --arg mimir "$mimir_sha" \
  '.repos.primary.ref = $primary
  | .repos.siblings.tempo.ref = $tempo
  | .repos.siblings.mimir.ref = $mimir' \
  "$LOCKFILE" > "$tmp_lock"

mv "$tmp_lock" "$LOCKFILE"

echo "Pinned fixture SHAs:"
echo "  primary (grafana/loki): $primary_sha"
echo "  sibling tempo (grafana/tempo): $tempo_sha"
echo "  sibling mimir (grafana/mimir): $mimir_sha"

tmp_loki="$(mktemp)"
tmp_tempo="$(mktemp)"
tmp_tempo_cfg="$(mktemp)"
tmp_mimir="$(mktemp)"
tmp_mimir_cfg="$(mktemp)"
trap 'rm -f "$tmp_lock" "$tmp_loki" "$tmp_tempo" "$tmp_tempo_cfg" "$tmp_mimir" "$tmp_mimir_cfg"' EXIT

curl -fsSL "https://raw.githubusercontent.com/grafana/loki/${primary_sha}/pkg/storage/factory.go" > "$tmp_loki"
curl -fsSL "https://raw.githubusercontent.com/grafana/tempo/${tempo_sha}/README.md" > "$tmp_tempo"
curl -fsSL "https://raw.githubusercontent.com/grafana/tempo/${tempo_sha}/modules/storage/config.go" > "$tmp_tempo_cfg"
curl -fsSL "https://raw.githubusercontent.com/grafana/mimir/${mimir_sha}/README.md" > "$tmp_mimir"
curl -fsSL "https://raw.githubusercontent.com/grafana/mimir/${mimir_sha}/pkg/storage/bucket/client.go" > "$tmp_mimir_cfg"

rg "storage_config\\.object_store" "$tmp_loki" >/dev/null
rg "requiring only object storage to operate" "$tmp_tempo" >/dev/null
rg "Trace backend \\(s3, azure, gcs, local\\)" "$tmp_tempo_cfg" >/dev/null
rg "uses object storage for long-term data storage" "$tmp_mimir" >/dev/null
rg "S3 = \"s3\"" "$tmp_mimir_cfg" >/dev/null

echo "Oracle sanity checks passed for pinned SHAs."
