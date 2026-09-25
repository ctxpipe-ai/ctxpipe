#!/bin/sh
# Apply tiering SQL inside the ClickHouse container (local default user).
# Refuses to run until the cold volume exists, so a config rollout that
# has not restarted yet cannot attach a TTL the server will reject.
set -eu
dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
cold=$(clickhouse-client --query "SELECT count() FROM system.storage_policies WHERE policy_name = 'default' AND volume_name = 'cold'")
if [ "$cold" != "1" ]; then
  echo "storage policy default has no volume cold; deploy config.d/storage.xml and restart ClickHouse first" >&2
  exit 1
fi
clickhouse-client --multiquery < "$dir/otel.sql"
clickhouse-client --multiquery < "$dir/langfuse.sql"
