# ClickHouse tiered storage

Hot data stays on the Railway volume. Older telemetry moves to a Railway S3-compatible bucket so retention can be long without growing the volume. The volume is `clickhouse-data` mounted at `/var/lib/clickhouse` (50 GiB cap, usage-billed, cannot shrink). The cold bucket is `clickhouse-cold` in region `iad`.

## Disks and policy

`config.d/storage.xml` defines:

| Piece | What it is |
| --- | --- |
| Disk `default` | The Railway volume. Unchanged. |
| Disk `s3_cold` | S3 disk. Endpoint and keys come from env (`from_env`). Object metadata is files under `/var/lib/clickhouse/disks/s3_cold/` on the volume. |
| Disk `s3_cold_cache` | Cache disk in front of `s3_cold`. Cap 256 MiB, segment 8 MiB, metadata load uses 2 threads. Writes are not cached, so a move to cold does not copy the part back onto the volume. |
| Policy `default` | Volume `default` (local disk) then volume `cold` (`s3_cold_cache`). `prefer_not_to_merge` on cold. `perform_ttl_move_on_insert` off, so an insert always lands on the local disk even when the row is already old. `move_factor` 0.2. |
| Policy `local_only` | Volume `default` only. |

Policy `default` is redefined, not given a new name. The built-in policy was one volume, `default`, on disk `default`. The new policy still has that volume and that disk, then adds `cold`. ClickHouse loads existing parts because the disk name did not change. ClickStack and Langfuse create `MergeTree` tables without `SETTINGS storage_policy`, so they keep using the name `default` and inherit the cold volume with no `ALTER ... MODIFY SETTING storage_policy`. A named policy would need that `ALTER` on every table, and a Langfuse migration that recreates a table would silently return it to a local-only policy.

`move_factor` 0.2 moves the oldest parts when free space on the hot filesystem drops below 20% (about 40 GiB used on the 50 GiB volume). That is the backstop. The usual move is the table TTL.

## Retention

Live ClickStack tables were created with `toIntervalDay(30)`. `config.d/ttl.xml` only sets `ttl_only_drop_parts`; it does not set a 14-day TTL.

| Data | Hot | Then |
| --- | --- | --- |
| `otel` tables listed in `tiering/otel.sql` | 3 days on the local volume | Volume `cold`, delete after 13 months |
| Tables the collector creates later | Stay hot until `move_factor`, or until `otel.sql` is extended and re-run | Delete after 390 days (`9360h` on the collector exporter `ttl`) |
| Langfuse | Stay hot until `move_factor` | Not deleted by this tiering |
| `system.query_log`, `system.error_log` | Local only (`local_only`), delete after 3 days | Never moved |

Three days is the hot window because recent HyperDX queries are the ones that need the local disk, and the measured ingest rate does not need more than that to stay far under the volume cap. On 2026-09-25 the `otel` parts were about 7.7 MiB across roughly 6.1 hours (~30 MiB/day). Three days of that is ~90 MiB. Thirteen months is ~12 GiB in the bucket. The rate will grow; the TTL, not the 50 GiB cap, is what keeps the hot set small.

`ttl_only_drop_parts` is on, and the `otel` tables are partitioned by day, so a delete drops a whole day part (including its S3 objects) instead of rewriting rows.

The collector exporter cannot express `TO VOLUME`. `ops/observability/collector/config.yaml` sets `exporters.clickhouse.ttl: 9360h` (390 days) so a newly created table is not stuck on the old 30-day delete. `tiering/otel.sql` is the reviewed statement that adds the 3-day move and the 13-month delete for the tables that already exist. Re-run it after adding a statement for any new `otel` table. Leave `HYPERDX_OTEL_EXPORTER_RECONCILE_TABLE_TTL` unset.

Langfuse migrations run on every `langfuse-web` and `langfuse-worker` boot. `tiering/langfuse.sql` only lists tables. It does not `MODIFY TTL`. A delete rule here would fight Langfuse, and a `TO VOLUME` rule would disappear if a migration recreated the table. Those tables still sit on policy `default`, so `move_factor` can move them when the volume fills, and a newly migrated table picks up the same policy.

## System logs

`query_log` and `error_log` set `<storage_policy>local_only</storage_policy>`. On the next start ClickHouse renames an existing log table whose `CREATE` no longer matches (`query_log` to `query_log_N`) and creates a new empty table on `local_only`. The renamed table keeps policy `default`. It has no `TO VOLUME` TTL and its rows are already inside the 3-day delete, so `move_factor` does not send them to S3 unless the volume is already past the 80% mark. Rotated names are not updated when the config changes.

## Bucket unreachable

`skip_access_check` is on for both `s3_cold` and `s3_cold_cache`. The cache disk's own startup probe writes a few bytes to S3, and the flag on the underlying disk does not cover it. With both flags set, startup does not contact S3. Inserts go to the first volume, including rows whose timestamp is already past the hot window (`perform_ttl_move_on_insert` is off on `cold`). Moves, and reads of column values from cold parts that missed the cache, fail until the bucket answers. `count()` over cold parts can still be answered from local part metadata. Hot reads and inserts still work. Metadata for cold parts remains on the volume, so a bucket outage does not drop the catalog of those parts.

Buckets are reached over the public network (Railway does not offer private-network bucket endpoints). Uploads count as service egress. Bucket egress and S3 API calls are free.

## Credentials

Required env vars, all references to the Railway bucket `clickhouse-cold` (no feature toggle):

| Variable | Railway reference |
| --- | --- |
| `CLICKHOUSE_COLD_ENDPOINT` | `${{clickhouse-cold.ENDPOINT}}/${{clickhouse-cold.BUCKET}}/clickhouse/` |
| `CLICKHOUSE_COLD_ACCESS_KEY_ID` | `${{clickhouse-cold.ACCESS_KEY_ID}}` |
| `CLICKHOUSE_COLD_SECRET_ACCESS_KEY` | `${{clickhouse-cold.SECRET_ACCESS_KEY}}` |
| `CLICKHOUSE_COLD_REGION` | `${{clickhouse-cold.REGION}}` |

`ENDPOINT` is the base URL (`https://t3.storageapi.dev` in the Railway docs) with no trailing slash. ClickHouse needs the bucket and a root path in that URL. New Railway buckets use virtual-hosted URLs; this composition is path-style, which is the form you can build from `ENDPOINT` and `BUCKET` without hard-coding the host. If the first move returns a path-style error, set `CLICKHOUSE_COLD_ENDPOINT` to `https://${{clickhouse-cold.BUCKET}}.<host>/clickhouse/` using the host from `ENDPOINT`.

Provider 0.6.1 cannot manage the bucket. Create it in Railway (region `iad`) and leave it out of Terraform state. The variable collection stores the references unrendered.

`support_batch_delete` is off. Railway documents Put, Get, Head, Delete, list, copy, and multipart upload. It does not document multi-object delete. TTL drops issue one delete per object.

S3 settings aimed at the 1 GiB cap: `background_move_pool_size` 1, PUT burst 2, cache metadata threads 2. Merge size is already capped at 256 MiB in `config.d/caches.xml`. Cold parts are not merged (`prefer_not_to_merge`).

## Apply

After the new image is running and `system.storage_policies` shows volume `cold`:

```bash
# inside the clickhouse container, local default user
/opt/ctxpipe/clickhouse-tiering/apply.sh
```

`apply.sh` exits if volume `cold` is missing, then runs `otel.sql` and `langfuse.sql`.

## Backups and rollback

The volume holds hot parts plus the S3 disk's local metadata. A volume backup that excludes `disks/s3_cold/` cannot read the bucket. Railway bucket deletion is restorable for 52 hours, then permanent. There is no object lock or versioning.

Do not deploy a ClickHouse config that drops disk `s3_cold` while parts still sit on `s3_cold_cache`. Move those parts back first:

```sql
ALTER TABLE otel.otel_logs MOVE PARTITION '2026-09-01' TO VOLUME 'default';
```

Then restore the previous 30-day TTL (`MODIFY TTL <time> + toIntervalDay(30)`), then deploy the previous image, then remove the four `CLICKHOUSE_COLD_*` variables. Removing the variables while this image is running prevents startup.

## Memory and the volume

`max_server_memory_usage` stays 1 GiB (`config.d/memory.xml`). The filesystem cache is disk, not RAM, and is capped at 256 MiB so it does not eat the hot volume. The volume cannot be shrunk; tiering stops usage from growing with retention, it does not lower the 50 GiB cap.
