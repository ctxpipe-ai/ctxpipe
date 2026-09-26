# ctxpipe-observability

Internal ClickStack (HyperDX + ClickHouse) and Langfuse. Railway project `ctxpipe-observability` (`305aa114-c6f3-4aca-b883-0faa9c331aa2`), `has_pr_deploys = false`, region `us-east4-eqdc4a`. Not the product project. Product apps export OTLP to `https://telemetry.ctxpipe.ai`. Decision: [ADR-038](../../.ai/memory/decisions/ADR-038-self-hosted-clickstack-langfuse.md).

Querying: [USING.md](./USING.md). Deploy: [terraform/README.md](./terraform/README.md).

## What runs

| Service | Image | Role |
| --- | --- | --- |
| collector | `ghcr.io/ctxpipe-ai/obs-collector` | Public OTLP at `telemetry.ctxpipe.ai`. LLM spans go to Langfuse. Scrapes itself and ClickHouse |
| clickhouse | `ghcr.io/ctxpipe-ai/obs-clickhouse` | 1 GiB, databases `otel` and `langfuse`, tiered. [clickhouse/README.md](./clickhouse/README.md) |
| hyperdx | `hyperdx/hyperdx:2.39.1` | UI at `hyperdx.ctxpipe.ai`. [hyperdx/README.md](./hyperdx/README.md) |
| mongo | `mongo:7` | HyperDX metadata |
| langfuse-web | `langfuse/langfuse:3` | UI at `langfuse.ctxpipe.ai` |
| langfuse-worker | `langfuse/langfuse-worker:3` | Ingestion |
| redis | `redis:7-alpine` | Langfuse queues |
| railway-telemetry | `ghcr.io/ctxpipe-ai/obs-railway-telemetry` | Five-minute cron. [railway-telemetry/README.md](./railway-telemetry/README.md) |

## Awake vs sleep

| Awake or scheduled | Sleeps when idle | Serverless on, stays up |
| --- | --- | --- |
| collector, clickhouse, langfuse-worker, redis | hyperdx | langfuse-web, mongo |
| railway-telemetry (starts, exports, exits) | | |

Sleep is a missing `railway.cpu` sample, not a zero. Nothing polls HyperDX, Mongo, or Langfuse web. The collector scrapes only itself and ClickHouse. Redis stays up because the worker does.

Langfuse web stays up on the stock image: the Prisma client and ioredis send keepalives. No `LANGFUSE_*` variable turns those off. Mongo stays Online with Serverless on; the volume is billed either way. The provider cannot set Serverless. Set collector and clickhouse Serverless off once in the Railway dashboard.

Langfuse Postgres is database `langfuse` on the existing Neon `ctxpipe` project. Event blobs are Railway bucket `langfuse-events`.

## Signals

Product traces, logs, and metrics use public OTLP. `service.name` is `backend`, `openworkflow`, `codesearch`, or `ui`. `deployment.environment`: [USING.md](./USING.md#localhost-telemetry). LLM spans take the collector `filter/llm_only` path into Langfuse. The browser posts traces to same-origin `/.otel/v1/traces` and logs to `/.otel/v1/logs`, with replay off. Collector and ClickHouse scrapes use `deployment.environment=observability`. Railway gauges and observability runtime logs come from `railway-telemetry`.

## Secrets

Railway holds the values. Terraform holds references and does not list the secret names, so apply cannot delete them.

| Service | Railway-owned | Terraform wires |
| --- | --- | --- |
| clickhouse | `CLICKHOUSE_OTEL_PASSWORD`, `CLICKHOUSE_LANGFUSE_PASSWORD` | cold-bucket references |
| collector | `HYPERDX_API_KEY`, `LANGFUSE_AUTH_STRING` | `CLICKHOUSE_PASSWORD` = `${{clickhouse.CLICKHOUSE_OTEL_PASSWORD}}` |
| hyperdx | — | ClickHouse password and `HYPERDX_API_KEY` from those services |
| langfuse-web | `DATABASE_URL`, `DIRECT_URL`, `NEXTAUTH_SECRET`, `SALT`, `ENCRYPTION_KEY`, init user email/password, project public/secret keys | ClickHouse password and the collector OTLP header |
| langfuse-worker | — | database, salt, and encryption key from langfuse-web |
| railway-telemetry | `RAILWAY_API_TOKEN` | collector OTLP header |

`LANGFUSE_AUTH_STRING` is `base64(pk:sk)` and must match the Langfuse project keys. `DATABASE_URL` and `DIRECT_URL` include `connection_limit=1&keepalives=0`.

## Deploy

CI builds `ghcr.io/ctxpipe-ai/obs-<svc>:<git tree hash>` and Terraform pins those images. Apply, the delete check, `prevent_destroy`, imports, and a fresh project: [terraform/README.md](./terraform/README.md). Dashboards: [hyperdx/README.md](./hyperdx/README.md).

Cost target is about $25–35/mo: one replica, ClickHouse capped at 1 GiB, no preview copies of this project.

If the ClickStack image cannot fan LLM spans out, run one contrib collector that exports to ClickHouse and Langfuse. Never run two collectors.
