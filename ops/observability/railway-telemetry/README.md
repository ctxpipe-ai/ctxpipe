# railway-telemetry

Cron in `ctxpipe-observability`. Every 5 minutes it starts, exports, and exits (`cronSchedule = "*/5 * * * *"`, `restartPolicyType = NEVER` in [`railway.toml`](./railway.toml)). It does not stay resident between runs.

One run:

- Railway GraphQL `metrics` for observability `production`, product `production`, and every product `pr-*` environment. Gauges: `railway.cpu.usage`, `railway.cpu.limit` (cores), `railway.memory.usage`, `railway.memory.limit`, `railway.network.rx`, `railway.network.tx`, `railway.disk.usage` (bytes). Network rx/tx is the bytes in that 60s sample, not a cumulative counter. The API read does not start a service.
- Observability `environmentLogs` for the same window (runtime stdout, cap 5000 lines). Build logs are not requested. Lines for this service are skipped. Product project logs are not collected.
- Redis `INFO` on `REDIS_URL`. The ClickStack collector image has no redis receiver. Levels (memory, clients, uptime, db keys) are gauges. Commands, keyspace hits/misses, and connections received are monotonic sums.

Project ids are in [`src/targets.ts`](./src/targets.ts). OTLP goes to the private collector.

## Window

`metricWindow` floors the end to the last 5-minute boundary. The window is `[end-5m, end)`, sampled every 60s. Points outside that range are dropped. The last sample at a timestamp wins. The Railway query asks for one extra sample before `start`, because `startDate` can be exclusive.

## Env

| Variable | Required | Role |
| --- | --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | yes | Collector base URL (`http://collector.railway.internal:4318`). Process exits 1 if unset |
| `OTEL_EXPORTER_OTLP_HEADERS` | with the collector | `authorization=<HYPERDX_API_KEY>` |
| `REDIS_URL` | for Redis gauges | `redis://redis.railway.internal:6379`. Unset: Redis metrics are skipped, a warning is logged, the run continues |
| `RAILWAY_API_TOKEN` | for Railway metrics and logs | Workspace token that can read both projects |

Without `RAILWAY_API_TOKEN`, Redis `INFO` and a WARN self-log still export, Railway metrics and environment logs are skipped, and the process exits 1.
