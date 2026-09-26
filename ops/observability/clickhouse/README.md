# ClickHouse

Hot data stays on the Railway volume `clickhouse-data` (`/var/lib/clickhouse`, 50 GiB cap). Older parts move to Railway bucket `clickhouse-cold` (region `iad`). Provider 0.6.1 cannot create the bucket.

## Disks and policy

`config.d/storage.xml`: disk `default` (the volume), disk `s3_cold` (S3; endpoint, key, secret, and region from env; metadata under `/var/lib/clickhouse/disks/s3_cold/`), disk `s3_cold_cache` (cap 256 MiB and 10240 files). Policy `default` is volume `default`, then volume `cold` (`s3_cold_cache`, no merges). Inserts stay local (`perform_ttl_move_on_insert` 0). `move_factor` 0.2. Policy `local_only` is the local disk only (`query_log`, `error_log`).

Policy `default` is redefined, not renamed. Volume `default` still uses disk `default`, so existing parts load. Tables created without `storage_policy` inherit `cold`.

`move_factor` 0.2 moves the oldest parts when free space on the hot filesystem drops below 20%. Parts on a `prefer_not_to_merge` volume still count toward `parts_to_delay_insert` (1000).

## Retention

`config.d/ttl.xml` sets `ttl_only_drop_parts` and `materialize_ttl_recalculate_only`. `MODIFY TTL` rewrites `ttl.txt` only.

| Data | Hot | Then |
| --- | --- | --- |
| `otel` tables in `tiering/otel.sql` | 3 days | Volume `cold`, delete after 390 days |
| Tables the collector seed creates later | Hot until `move_factor` or `otel.sql` gains a statement | Delete after 390 days |
| `langfuse.traces`, `observations`, `scores` | 30 days, then volume `cold` | Not deleted |
| `system.query_log`, `system.error_log` | Local only, delete after 3 days | Never moved |

390 days is `9360h`. The collector image sets `HYPERDX_OTEL_EXPORTER_TABLES_TTL=9360h` (`toIntervalDay(390)`). Leave `HYPERDX_OTEL_EXPORTER_RECONCILE_TABLE_TTL` unset so boot does not rewrite `tiering/otel.sql`. `otel` tables are partitioned by day. Langfuse SQL only moves (`tiering/langfuse.sql`); reads use `FINAL`.

If the `query_log` or `error_log` `CREATE` changes, ClickHouse renames the old table (`query_log_N`, `error_log_N`). Those copies have no TTL; drop them by hand.

## Bucket outage

`skip_access_check` is 0 on `s3_cold` and `s3_cold_cache`. An unreachable bucket at start fails the disk check and the process exits. Provider 0.6.1 cannot set restart policy, so the observability workflow sets ON_FAILURE with 120 retries and healthcheck `/ping` ([`scripts/railway-observability-service-settings.sh`](../../../scripts/railway-observability-service-settings.sh); platform default is 10 retries). After 120 failed boots the deployment stays Crashed until a restart.

While ClickHouse is down, `clickstack-otel-collector:2.39.1` retries export for 300s, then drops the batch. `memory_limiter` is 1500 MiB. The image sets no `sending_queue`; the exporter default is 1000 batches. `max_server_memory_usage` is 1 GiB (`config.d/memory.xml`).

If the process is up and the bucket later fails, hot inserts still land locally. A cold-column read fails after the S3 timeout (10s, one retry) and inside `max_execution_time` 120s. `count()` over cold parts can be answered from local metadata.

## Credentials

| Variable | Railway reference |
| --- | --- |
| `CLICKHOUSE_COLD_ENDPOINT` | `${{clickhouse-cold.ENDPOINT}}/${{clickhouse-cold.BUCKET}}/clickhouse/` |
| `CLICKHOUSE_COLD_ACCESS_KEY_ID` | `${{clickhouse-cold.ACCESS_KEY_ID}}` |
| `CLICKHOUSE_COLD_SECRET_ACCESS_KEY` | `${{clickhouse-cold.SECRET_ACCESS_KEY}}` |
| `CLICKHOUSE_COLD_REGION` | `${{clickhouse-cold.REGION}}` |

`ENDPOINT` has no trailing slash (path-style). The image does not start if these are empty or the bucket is unreachable.

## DeploymentEnvironment

`schema/deployment-environment.sql` adds `DeploymentEnvironment` (`ADD COLUMN IF NOT EXISTS`) on every `otel` table with `ResourceAttributes`. The expression is `ResourceAttributes['deployment.environment']`. Do not rename that attribute. Do not use the dotted `__hdx_materialized_deployment.environment` name on `otel_logs` (nested prefix of the seed column).

`ADD` is safe to repeat. `MATERIALIZE COLUMN` already ran and is not in the file; repeating it rewrites parts.

Run `tiering/otel.sql` as `otel`, `tiering/langfuse.sql` as `langfuse`, and `schema/deployment-environment.sql` as `otel`, after `system.storage_policies` shows volume `cold`. Apply a new table's statement on its own.

Do not deploy a config that drops disk `s3_cold` while parts sit on `s3_cold_cache`. Move those partitions to volume `default` first. A backup that omits `disks/s3_cold/` cannot read the bucket.
