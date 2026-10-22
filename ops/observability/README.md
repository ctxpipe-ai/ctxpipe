# ctxpipe-observability

Internal ClickStack (HyperDX + ClickHouse) and Langfuse. Railway project `ctxpipe-observability` (`305aa114-c6f3-4aca-b883-0faa9c331aa2`), `has_pr_deploys = false`, region `us-east4-eqdc4a`. Not the product project. Product apps export OTLP to `https://telemetry.ctxpipe.ai`. Decision: [ADR-038](../../.ai/memory/decisions/ADR-038-self-hosted-clickstack-langfuse.md).

Querying: [USING.md](./USING.md). Deploy: [terraform/README.md](./terraform/README.md).

## What runs

| Service | Image | Role |
| --- | --- | --- |
| collector | `ghcr.io/ctxpipe-ai/obs-collector` | Public OTLP at `telemetry.ctxpipe.ai`. LLM spans go to Langfuse. Scrapes itself and ClickHouse |
| clickhouse | `ghcr.io/ctxpipe-ai/obs-clickhouse` | 4 GiB cap, databases `otel` and `langfuse`, tiered. [clickhouse/README.md](./clickhouse/README.md) |
| hyperdx | `hyperdx/hyperdx:2.39.1` | UI at `hyperdx.ctxpipe.ai`. [hyperdx/README.md](./hyperdx/README.md) |
| mongo | `mongo:7` | HyperDX metadata |
| langfuse-web | `langfuse/langfuse:3` | UI at `langfuse.ctxpipe.ai` |
| langfuse-worker | `langfuse/langfuse-worker:3` | Ingestion |
| redis | `redis:7-alpine` | Langfuse queues |
| railway-telemetry | `ghcr.io/ctxpipe-ai/obs-railway-telemetry` | Five-minute cron. [railway-telemetry/README.md](./railway-telemetry/README.md) |
| cost-telemetry | `ghcr.io/ctxpipe-ai/obs-cost-telemetry` | Hourly cron at :17. [cost-telemetry/README.md](./cost-telemetry/README.md) |

## Awake vs sleep

| Awake or scheduled | Serverless on, stays up |
| --- | --- |
| collector, clickhouse, hyperdx, langfuse-worker, redis | langfuse-web, mongo |
| railway-telemetry, cost-telemetry (starts, exports, exits) | |

HyperDX has Serverless off. The first MCP call after a sleep got a Cloudflare 504 while the container woke up, and HyperDX is the first tool for incident triage. It uses about 0.25 GB of memory. A sleeping service shows as a missing `railway.cpu` sample, not a zero. Nothing polls Mongo or Langfuse web. The collector scrapes only itself and ClickHouse. Redis stays up because the worker does.

Langfuse web stays up on the stock image: the Prisma client and ioredis send keepalives. No `LANGFUSE_*` variable turns those off. Mongo stays Online with Serverless on; the volume is billed either way. Collector, ClickHouse, and HyperDX have Serverless off. Terraform does not manage this setting. Provider 0.6.1 omits `sleepApplication` on update, so apply neither turns it off nor turns it back on. Set it in Railway (service Settings, Serverless off) or with the `serviceInstanceUpdate` mutation (`sleepApplication: false`).

Langfuse Postgres is database `langfuse` on the existing Neon `ctxpipe` project. Event blobs are Railway bucket `langfuse-events`.

## Signals

Product traces, logs, and metrics use public OTLP. `service.name` is `backend`, `openworkflow`, `codesearch`, or `ui`. `deployment.environment`: [USING.md](./USING.md#localhost-telemetry). LLM spans take the collector `filter/llm_only` path into Langfuse. The browser posts traces to same-origin `/.otel/v1/traces` (replay off; console capture is spans). The relay also accepts `/.otel/v1/logs`, but the SDK does not use it. Collector and ClickHouse scrapes use `deployment.environment=observability`. Railway gauges and observability runtime logs come from `railway-telemetry`.

## Secrets

No secret is set by hand in Railway. The protected GitHub `observability` Environment holds each one, and after each apply [`scripts/railway-sync-variables.py`](../../scripts/railway-sync-variables.py) writes it straight to the Railway service variables. The values do not enter Terraform inputs, plan output, or state. When a value changes, the apply job redeploys that service and the services that refer to it, in reference order. A re-run or a manual run redeploys every service. Terraform holds the values that are not secret and the references. `NEON_ORG_ID` and `CLOUDFLARE_ACCOUNT_ID` are GitHub variables, not secrets.

| Service | GitHub Environment → Railway variable | Terraform wires |
| --- | --- | --- |
| clickhouse | `CLICKHOUSE_OTEL_PASSWORD`, `CLICKHOUSE_LANGFUSE_PASSWORD` | cold-bucket references |
| collector | `HYPERDX_API_KEY`; `LANGFUSE_AUTH_STRING` made from `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` | `CLICKHOUSE_PASSWORD` = `${{clickhouse.CLICKHOUSE_OTEL_PASSWORD}}` |
| hyperdx | — | ClickHouse password and `HYPERDX_API_KEY` from those services |
| langfuse-web | `LANGFUSE_DATABASE_URL` → `DATABASE_URL`, `LANGFUSE_DIRECT_URL` → `DIRECT_URL`, `LANGFUSE_NEXTAUTH_SECRET` → `NEXTAUTH_SECRET`, `LANGFUSE_SALT` → `SALT`, `LANGFUSE_ENCRYPTION_KEY` → `ENCRYPTION_KEY`, `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` → `LANGFUSE_INIT_PROJECT_*_KEY`, `LANGFUSE_INIT_USER_EMAIL`, `LANGFUSE_INIT_USER_PASSWORD` | ClickHouse password and the collector OTLP header |
| langfuse-worker | — | database, salt, and encryption key from langfuse-web |
| railway-telemetry | `TELEMETRY_RAILWAY_WORKSPACE_TOKEN` → `RAILWAY_API_TOKEN` | collector OTLP header |
| cost-telemetry | `COST_TELEMETRY_*` provider credentials, `TELEMETRY_RAILWAY_WORKSPACE_TOKEN` → `RAILWAY_API_TOKEN` | collector OTLP header |

`DATABASE_URL` and `DIRECT_URL` include `connection_limit=1&keepalives=0`. The product GitHub secret `OBSERVABILITY_OTLP_HEADERS` is `authorization=<HYPERDX_API_KEY>`, so change both together.

Langfuse reads the `LANGFUSE_INIT_*` values only to create a missing user and API key. It finds the key by its public key. So a key rotation needs a new `LANGFUSE_PUBLIC_KEY` and a new `LANGFUSE_SECRET_KEY` together; then delete the old key in the Langfuse project settings. A new `LANGFUSE_INIT_USER_PASSWORD` does not change the password of the existing user: change it in Langfuse. A new `SALT` does not revoke an old key. A new `ENCRYPTION_KEY` makes stored LLM connection keys unreadable: enter them again. While the services restart after a ClickHouse or key rotation, OTLP ingestion and LLM traces stop for a short time.

## Deploy

CI builds `ghcr.io/ctxpipe-ai/obs-<svc>:<git tree hash>` and Terraform pins those images. Apply, the delete check, `prevent_destroy`, imports, and a fresh project: [terraform/README.md](./terraform/README.md). Dashboards: [hyperdx/README.md](./hyperdx/README.md).

Cost target is about $25–35/mo at idle: one replica, ClickHouse capped at 4 GiB (Railway bills used RAM), no preview copies of this project.

If the ClickStack image cannot fan LLM spans out, run one contrib collector that exports to ClickHouse and Langfuse. Never run two collectors.

## Langfuse model prices

Langfuse computes the cost of a generation from its model price table. The built-in table has no entry for some product models, or matches them only without the gateway prefix. [langfuse/models.json](./langfuse/models.json) holds the custom entries. Prices are OpenRouter list prices from 2026-10-11. After a rebuild, or when a price or a default model changes, run `LANGFUSE_AUTH_STRING=<base64 pk:sk> ops/observability/langfuse/apply-models.sh`. A chat generation also sends the gateway cost (`gen_ai.usage.cost`) when the gateway reports it.
