# ClickHouse tiered storage

Hot data stays on the Railway volume `clickhouse-data` (`/var/lib/clickhouse`, 50 GiB cap, usage-billed, cannot shrink). Older parts move to Railway bucket `clickhouse-cold` (region `iad`). Provider 0.6.1 cannot create the bucket. Terraform stores unrendered references only.

## Disks and policy

`config.d/storage.xml`:

| Piece | What it is |
| --- | --- |
| Disk `default` | The Railway volume. |
| Disk `s3_cold` | S3. Endpoint, key, secret, and region come from env. Object metadata is local, under the default path `/var/lib/clickhouse/disks/s3_cold/`. |
| Disk `s3_cold_cache` | Cache in front of `s3_cold`, cap 256 MiB and 10240 files. |
| Policy `default` | Volume `default` (local disk), then volume `cold` (`s3_cold_cache`). Cold does not merge. Inserts stay on the local disk (`perform_ttl_move_on_insert` 0). `move_factor` 0.2. |
| Policy `local_only` | Local disk only. `query_log` and `error_log` use it. |

Policy `default` is redefined, not renamed. The built-in policy was volume `default` on disk `default`. The new policy still has that volume and disk, then adds `cold`, so existing parts load. ClickStack and Langfuse create MergeTree tables without `SETTINGS storage_policy`, so they inherit `cold` with no storage-policy `ALTER`.

`move_factor` 0.2 moves the oldest parts when free space on the hot filesystem drops below 20%. Live `system.disks` reports about 45.5 GiB, so that is about 36 GiB used. The usual move is the table TTL.

Parts on a `prefer_not_to_merge` volume still count toward `parts_to_delay_insert` (1000) per partition. Daily partitions are merged while they are hot. A late insert into an old day can leave a tiny cold part.

## Retention

`config.d/ttl.xml` sets `ttl_only_drop_parts` and `materialize_ttl_recalculate_only`. There is no server-wide TTL expression. `MODIFY TTL` rewrites `ttl.txt` only, so applying the SQL again does not download cold parts.

| Data | Hot | Then |
| --- | --- | --- |
| `otel` tables in `tiering/otel.sql` | 3 days | Volume `cold`, delete after 390 days |
| Tables the collector seed creates later | Hot until `move_factor` or until `otel.sql` gains a statement | Delete after 390 days |
| `langfuse.traces`, `observations`, `scores` | 30 days, then volume `cold` | Not deleted |
| `system.query_log`, `system.error_log` | Local only, partitioned by `event_date`, delete after 3 days | Never moved |

390 days is `9360h` (`13 * 30` days). The collector image sets `HYPERDX_OTEL_EXPORTER_TABLES_TTL=9360h`. ClickStack 2.39.1 does not use `exporters.clickhouse.ttl`. `/entrypoint.sh` runs `migrate /etc/otel/schema/seed`, which templates `${LOGS_TTL}` and the other signal TTLs from that env (default `720h` = 30 days) into `toIntervalDay(390)`. `HYPERDX_OTEL_EXPORTER_RECONCILE_TABLE_TTL` is unset. The migrate binary skips a multi-interval TTL (`TO VOLUME` plus `DELETE`) so a boot does not rewrite `tiering/otel.sql`.

`otel` tables are partitioned by day, so a delete drops a whole day part, including its S3 objects.

Langfuse base tables have no TTL of their own. Upstream 7-day and 30-day TTLs belong to optional aggregating tables (`traces_7d_amt`, `traces_30d_amt`) that are not in this database. `tiering/langfuse.sql` only moves. Monthly partitions mean about one to two months stays on the volume. Cold `ReplacingMergeTree` parts are not merged, so old versions remain; Langfuse reads with `FINAL`.

On the next start, `query_log` and `error_log` are renamed if their `CREATE` changed (day partitions) and recreated on `local_only`.

## Bucket outage

`skip_access_check` is 0 on `s3_cold` and on `s3_cold_cache`. If the bucket is unreachable when the process starts, the disk check fails and the process exits. It does not stay up with tables that failed to load. ClickHouse 26.8 loads tables asynchronously (`async_load_databases=1`) and does not retry a failed load, so the old `skip_access_check=1` behavior left inserts and hot reads broken until a person restarted the server.

`ops/observability/clickhouse/railway.toml` sets `restartPolicyType = "ON_FAILURE"` and `restartPolicyMaxRetries = 120`. The schema allows `ON_FAILURE`, `ALWAYS`, and `NEVER`. `ON_FAILURE` restarts a non-zero exit. `ALWAYS` would also restart a clean exit. Provider 0.6.1 `railway_service` does not set this; the toml is the committed config and overrides the dashboard for that deployment. The platform default without the retries field is 10. After 120 failed boots the deployment is Crashed and stays down until someone restarts it once the bucket is back.

While ClickHouse is down, the collector keeps running. Image `clickhouse/clickstack-otel-collector:2.39.1` (`/etc/otelcol-contrib/config.yaml` and `standalone-config.yaml`):

- Batch processor: `send_batch_size` 10000, timeout 5s, no max size.
- `memory_limiter`: 1500 MiB, spike 512 MiB.
- ClickHouse exporter `retry_on_failure`: initial 5s, max interval 30s, `max_elapsed_time` 300s. A batch is dropped after five minutes of export failure.
- No `sending_queue` in the image config. The exporter helper default is on: 1000 batches (`sizer: requests`), 10 consumers, overflow rejects rather than blocks.

At the measured ~30 MiB/day, five minutes of telemetry is a fraction of a megabyte, so the queue does not fill during a short restart loop. An outage longer than five minutes drops batches that exhausted retries. An outage longer than the 120 restarts leaves ClickHouse Crashed until a restart.

If the process is already up and the bucket then goes away, hot inserts still land on the local disk. A query that must read a cold column fails after the S3 request timeout (10s, one retry) and inside `max_execution_time` 120s on the default profile (`otel`, `langfuse`, and the default user). `count()` over cold parts can still be answered from local part metadata.

Buckets are on the public network. Uploads count as service egress ($0.05/GB). Bucket storage is $0.015/GB-month. API calls and bucket egress are free.

## Credentials

| Variable | Railway reference |
| --- | --- |
| `CLICKHOUSE_COLD_ENDPOINT` | `${{clickhouse-cold.ENDPOINT}}/${{clickhouse-cold.BUCKET}}/clickhouse/` |
| `CLICKHOUSE_COLD_ACCESS_KEY_ID` | `${{clickhouse-cold.ACCESS_KEY_ID}}` |
| `CLICKHOUSE_COLD_SECRET_ACCESS_KEY` | `${{clickhouse-cold.SECRET_ACCESS_KEY}}` |
| `CLICKHOUSE_COLD_REGION` | `${{clickhouse-cold.REGION}}` |

`ENDPOINT` has no trailing slash. This composition is path-style. If a move fails on path style, set the endpoint to `https://${{clickhouse-cold.BUCKET}}.<host>/clickhouse/` using the host from `ENDPOINT`.

The new image does not start if these four variables are empty, and it does not start if the bucket is unreachable.

## Apply

After the image is up and `system.storage_policies` shows volume `cold`, run the SQL with any client as a user who can `ALTER` the database. The probe user `otel` can alter `otel`. The probe user `langfuse` can alter `langfuse`.

```sql
-- otel.sql, user otel
-- langfuse.sql, user langfuse
```

Run a new table's statement when the collector seed adds one. Do not re-apply the whole file unless `materialize_ttl_recalculate_only` is 1.

## Backups and rollback

The volume holds hot parts and the S3 disk's local metadata. A backup that omits `disks/s3_cold/` cannot read the bucket. A bucket listing is not a table. Railway bucket deletion is restorable for 52 hours.

Do not deploy a config that drops disk `s3_cold` while parts still sit on `s3_cold_cache`. Move those partitions to volume `default` first, restore the previous TTL, deploy the previous image, then remove the four `CLICKHOUSE_COLD_*` variables.

## Memory

`max_server_memory_usage` is 1 GiB. The filesystem cache is disk, capped at 256 MiB. The volume cap cannot shrink.
