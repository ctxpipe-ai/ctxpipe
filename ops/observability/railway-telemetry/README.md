# railway-telemetry

Cron in `ctxpipe-observability`. Every 5 minutes it starts, exports, and exits (`cronSchedule = "*/5 * * * *"`, `restartPolicyType = NEVER` in [`railway.toml`](./railway.toml)). It does not stay resident between runs.

One run:

- Railway GraphQL `metrics` for observability `production`, product `production`, and every product `pr-*` environment. Gauges: `railway.cpu.usage`, `railway.cpu.limit` (cores), `railway.memory.usage`, `railway.memory.limit`, `railway.network.rx`, `railway.network.tx`, `railway.disk.usage` (bytes). Network rx/tx is the public bytes in that 60s sample, not a cumulative counter and not private-network traffic. The API read does not start a service. One environment failing does not stop the others; the self log counts `railway.telemetry.environment_failures` and the process still exits 1.
- Observability `environmentLogs` for that signal's window (runtime stdout, cap 5000 lines). Build logs are not requested. Lines for this service are skipped. Product project logs are not collected.
- Redis `INFO` on `REDIS_URL`. The ClickStack collector image has no redis receiver. Levels (memory, clients, uptime, db keys) are gauges. Commands, keyspace hits/misses, and connections received are monotonic sums.

Project ids are in [`src/targets.ts`](./src/targets.ts). OTLP goes to the private collector.

## Window

Each signal keeps a high-water mark in Redis on the same `REDIS_URL` as `INFO`: `railway-telemetry:watermark:metrics` and `railway-telemetry:watermark:logs`. The value is the last unix second already exported.

A run queries `(watermark, end)`. `end` is the last closed minute at least 60s before now, because Railway stamps a 60s bucket at its start and that bucket is still open until the next minute. The start is the second after the mark, and it is never older than 60 minutes before `end`, so a long outage cannot pull more than that. Samples and log lines in the half-open window are strictly newer than the mark. After a clean export of that signal, the mark advances to `end - 1`. A signal that failed to fetch keeps its mark so the next run retries it.

The first run (no key) exports the 5 minutes before `end`. If Redis cannot be reached, the run uses the fixed `[end-5m, end)` window aligned to the 5-minute boundary, logs a warning, and does not write a mark.

Points outside `[start, end)` are dropped. The last sample at a timestamp wins. The Railway query asks for one extra sample before `start`, because `startDate` can be exclusive.

## Series that are dropped

A measurement is kept only when its `serviceId` is in that project's service list. A nil id such as `00000000-0000-0000-0000-000000000000` is dropped. When a service has CPU or memory usage in one or more regions in the same window, measurements for its other regions are dropped. That removes a leftover disk series from a region the service no longer runs in. If the window has no CPU or memory usage for the service, the other measurements are kept.

## Network and region

`railway.network.rx` and `railway.network.tx` are Railway's public ingress and egress. Traffic on the private network (the collector writing to ClickHouse, Langfuse using Redis) is not in these series, so those services are often 0.

`railway.region` is the metric tag Railway returns, for example `us-east4-eqdc16a` or `us-east4` with no zone suffix. It is not the region configured on the service (`us-east4-eqdc4a`). Dashboards should not filter on the configured region string.

## Env

| Variable | Required | Role |
| --- | --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | yes | Collector base URL (`http://collector.railway.internal:4318`). Process exits 1 if unset |
| `OTEL_EXPORTER_OTLP_HEADERS` | with the collector | `authorization=<HYPERDX_API_KEY>` |
| `REDIS_URL` | for Redis gauges and the export watermarks | `redis://redis.railway.internal:6379`. Unset: Redis metrics are skipped, the run uses the fixed 5-minute window, a warning is logged, and the run continues |
| `RAILWAY_API_TOKEN` | for Railway metrics and logs | Workspace token that can read both projects |

Without `RAILWAY_API_TOKEN`, Redis `INFO` and a WARN self-log still export, Railway metrics and environment logs are skipped, and the process exits 1.
