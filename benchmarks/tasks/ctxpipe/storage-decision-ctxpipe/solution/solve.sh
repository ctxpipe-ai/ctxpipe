#!/bin/bash
set -euo pipefail

cat > /app/answer.json <<'EOF'
{
  "selected_option": "object_storage",
  "alternatives_considered": [
    "block_storage",
    "local_disk"
  ],
  "evidence": [
    {
      "repo": "grafana/loki",
      "path": "pkg/storage/factory.go",
      "claim": "Loki enables object storage clients via storage_config.object_store when use-thanos-objstore is set.",
      "supports_option": true
    },
    {
      "repo": "grafana/tempo",
      "path": "README.md",
      "claim": "Tempo is cost-efficient and requires only object storage to operate.",
      "supports_option": true
    },
    {
      "repo": "grafana/tempo",
      "path": "modules/storage/config.go",
      "claim": "Tempo trace.backend supports s3, azure, gcs, and local backends.",
      "supports_option": true
    },
    {
      "repo": "grafana/mimir",
      "path": "README.md",
      "claim": "Mimir uses object storage for long-term durable metric storage.",
      "supports_option": true
    }
  ],
  "decision_summary": "Object storage is the best default because all three systems document native object-store backends for durable distributed telemetry workloads."
}
EOF
