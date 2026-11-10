# Using the stack

How to read hosted telemetry and how to send a laptop into it. What runs and how it is deployed: [README.md](./README.md). Agents: [observability skill](../../.agents/skills/observability/SKILL.md).

HyperDX: https://hyperdx.ctxpipe.dev, behind Cloudflare Access (factory `machines/observability`, CTX-1216). Spans keep the prompt text; Langfuse is gone. OTLP: https://otel.ctxpipe.dev with `OTEL_EXPORTER_OTLP_HEADERS=CF-Access-Client-Id=<id>,CF-Access-Client-Secret=<secret>` (the Access service token `telemetry`, in production Secrets Manager at `cloudflare/access/telemetry`; the GitHub secret `OBSERVABILITY_OTLP_HEADERS` holds the same value).

## Accounts

HyperDX: open https://hyperdx.ctxpipe.dev, pass Access with your `ctxpipe.ai` Google account, sign in, then Team Settings → API Keys. That personal key is `HYPERDX_ACCESS_KEY` for MCP. Agents use the key of the `agents` HyperDX user ([Agent hosts](#agent-hosts)).

## From a complaint to a trace

1. Copy `x-request-id`, or the time, user, and org.
2. Set the environment. Hosted apps use `production` or `pr-<digits>`. This stack uses `observability`. A laptop opt-in is `local-<name>`. Dashboards that default to `production` are listed below. Clear that chip to see a preview or a local run.
3. Open saved search **Request by id** (logs) or **Request by id (traces)** and set the where clause to `LogAttributes['request.id'] = '<id>'` or `SpanAttributes['request.id'] = '<id>'`. Read `TraceId` and open the trace.
4. LLM prompt and completion text is on the gen_ai span in HyperDX (`SpanAttributes['gen_ai.prompt']` and the other `gen_ai.*` keys). Traces stay 30 days.
5. If the window is empty, check the environment chip and the service (`backend`, `openworkflow`, `codesearch`, `ui`). Stdout of a process that never exported: on AWS, `service.name=cloudwatch:<log group>` in HyperDX, or CloudWatch through the audit role ([Agent hosts](#agent-hosts)); on Railway, until the cutover, the Railway MCP.

## Dashboards

Connection **ctxpipe ClickHouse**. Upsert, saved searches, and default chips: [hyperdx/README.md](./hyperdx/README.md).

| Dashboard | What it answers |
| --- | --- |
| ctxpipe Services | Request rate, error rate, p95, slowest routes, log volume, recent errors |
| LLM (gen_ai) | Call count, error rate, tokens, latency by model |
| Observability Stack | Collector, ClickHouse, and railway-telemetry |
| Railway Infrastructure | CPU, memory, network, disk, every environment |
| Product usage | DAU/WAU/MAU, MCP, stickiness. [definitions](./hyperdx/dashboards/product-usage.md) |

Sessions charts stay empty while browser replay is off.

## MCP

Repo config: [`.mcp.json`](../../.mcp.json) (Claude Code), [`.codex/config.toml`](../../.codex/config.toml) (Codex) and [`.cursor/mcp.json`](../../.cursor/mcp.json) (Cursor). The server lists are the same.

| Server | URL | Headers | Environment variables |
| --- | --- | --- | --- |
| `hyperdx` | `https://hyperdx.ctxpipe.dev/api/mcp` | `Authorization: Bearer <key>`, `CF-Access-Client-Id`, `CF-Access-Client-Secret` | `HYPERDX_ACCESS_KEY`, `HYPERDX_CF_ACCESS_CLIENT_ID`, `HYPERDX_CF_ACCESS_CLIENT_SECRET` |
| `railway` | stdio `railway mcp local` | — | `RAILWAY_API_TOKEN` |

Cloudflare Access checks the two `CF-Access-*` headers (the `agents` service token) and HyperDX checks the bearer key. Without the Access headers the call gets the Access login page (HTTP 302 or 403). A wrong HyperDX key often shows up as HTTP 405 while the client probes OAuth.

```bash
claude mcp add --transport http hyperdx https://hyperdx.ctxpipe.dev/api/mcp \
  --header "Authorization: Bearer ${HYPERDX_ACCESS_KEY}" \
  --header "CF-Access-Client-Id: ${HYPERDX_CF_ACCESS_CLIENT_ID}" \
  --header "CF-Access-Client-Secret: ${HYPERDX_CF_ACCESS_CLIENT_SECRET}"
```

ClickHouse has no hostname outside its host: it listens on localhost only. Query it through HyperDX (`clickstack_sql`, `clickstack_search` and the other `clickstack_*` tools).

## Agent hosts

Agents debug production and previews with no person in the loop (ADR-061 decision 25): HyperDX first, then AWS reads through the read-only audit role.

**The three HyperDX variables.** Each agent host needs them in the environment of its agents. A person with production access gets the values once per host:

- `HYPERDX_ACCESS_KEY`: the personal API key of the HyperDX user `agents` (Team Settings → API Keys, signed in as that user).
- `HYPERDX_CF_ACCESS_CLIENT_ID` and `HYPERDX_CF_ACCESS_CLIENT_SECRET`: the `clientId` and `clientSecret` of the Access service token `agents`, in production Secrets Manager at `cloudflare/access/agents` (the factory edge stack writes it):

  ```bash
  aws secretsmanager get-secret-value --profile ctxpipe-production --region us-west-2 \
    --secret-id cloudflare/access/agents --query SecretString --output text
  ```

Never print, paste, or commit the values. Put them here:

| Host | Where |
| --- | --- |
| Laptop | Your shell profile (`~/.zshrc`), as `export` lines. Claude Code and Codex read them at start. |
| Factory host with Paseo | `~/.paseo/config.json`: `agents.providers.<provider>.env` for each provider that you use (`claude`, `codex`, ...), then `paseo reload`. New agents get them; a running agent does not. Paseo agents do not read `~/.zshrc`. |
| Remote VM or cloud agent | The environment settings of that harness. |

Check: `claude mcp list` (or `codex mcp list`) shows `hyperdx` as connected.

**AWS reads.** The `factory-audit` role of each account reads CloudWatch Logs and metrics, ECS, RDS, EC2 and AgentCore state, and no secret, object or log-unmask (factory `machines/aws-core/stacks/baseline/README.md`). On a laptop, use your SSO profile. On a factory host, chain from the host's `ctxpipe-factory-auditor` profile; add to `~/.aws/config`:

```ini
[profile ctxpipe-production-audit]
source_profile = ctxpipe-factory-auditor
role_arn = arn:aws:iam::213102790567:role/factory-audit
region = us-west-2

[profile ctxpipe-preview-audit]
source_profile = ctxpipe-factory-auditor
role_arn = arn:aws:iam::573018602187:role/factory-audit
region = us-west-2
```

For example `aws logs tail /ctxpipe/backend --since 30m --profile ctxpipe-production-audit`, or `aws ecs describe-services --cluster <cluster> --services <service> --profile ctxpipe-production-audit`. Log events can hold customer data: the privacy rules of [AGENTS.md](../../AGENTS.md) decide what may leave the session.

## Localhost telemetry

Leave `OTEL_EXPORTER_OTLP_*` unset unless this run needs a backend. `pnpm dev` does not set them. `deployment.environment` is `DEPLOYMENT_ENVIRONMENT` when that is set (`RAILWAY_ENVIRONMENT_NAME` is the fallback while Railway previews exist), otherwise `deployment.environment` from `OTEL_RESOURCE_ATTRIBUTES`, otherwise `production` when `NODE_ENV=production`, otherwise `development`. Backend and codesearch set `service.namespace=ctxpipe`.

**Laptop collector.** `pnpm dev:infra` publishes `${CTXPIPE_OTEL_COLLECTOR_HOST_PORT:-4318}:4318` on every interface. Point the app at `http://127.0.0.1:4318/v1/traces`, `/v1/logs`, and `/v1/metrics`. Omit the headers. `OTEL_SERVICE_NAME` is `backend`, `openworkflow`, or `codesearch`. The collector prints OTLP to its own logs. There is no local HyperDX.

**Shared collector (opt-in).** Use it when the hosted dashboards should show this run; [preview-env](../../.agents/skills/preview-env/run-setup.md#local-trace-export) local runs always do. It stays opt-in because the run's prompts go into the shared store for 30 days.

Put these lines in `apps/backend/.env.local` (gitignored; never commit the token):

```bash
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://otel.ctxpipe.dev/v1/traces
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=https://otel.ctxpipe.dev/v1/logs
OTEL_EXPORTER_OTLP_HEADERS=CF-Access-Client-Id=<id>,CF-Access-Client-Secret=<secret>
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=local-<name>
```

`<name>` is the person or agent. Filter HyperDX to that environment. The header values are the Access service token `telemetry` (`cloudflare/access/telemetry` in production Secrets Manager), not a HyperDX key. Add `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://otel.ctxpipe.dev/v1/metrics` only when the run needs metrics; `local-*` uses the 60s metric reader, so a process that exits immediately can miss gauges.

`pnpm dev` hands them to every local process: Bun loads `.env.local` for the backend and the OpenWorkflow worker, `scripts/codesearch-docker-dev.sh` passes them into the codesearch container, and Turbo passes them to the UI server, whose `/.otel` relay then forwards browser spans. The worker reports as `service.name=backend` unless `OTEL_SERVICE_NAME` is set, and that is fine locally. Use `OTEL_RESOURCE_ATTRIBUTES`, not `DEPLOYMENT_ENVIRONMENT`: the backend also reads `DEPLOYMENT_ENVIRONMENT` for preview behavior. Headless runs (`scripts/dev-headless.sh`, the cloud-VM runbook) load `.env.local` only into the backend and worker; export the same variables in the shell that starts them to cover the UI and codesearch. The codesearch container reaches a laptop collector at `localhost` or `127.0.0.1` through `host.docker.internal`.

## Retention

| Data | Hot (volume) | Then |
| --- | --- | --- |
| Traces, logs, sessions (they hold prompt text) | 3 days | Cold bucket, deleted after 30 days |
| Metrics | 3 days | Cold bucket, deleted after 390 days |
| `system.query_log`, `system.error_log` | 3 days, local disk | Deleted |

A search older than the hot window reads the bucket. If the bucket is down, that query fails within 120 seconds. `count()` can use local part metadata. Detail: factory `machines/observability/clickhouse/README.md`.
