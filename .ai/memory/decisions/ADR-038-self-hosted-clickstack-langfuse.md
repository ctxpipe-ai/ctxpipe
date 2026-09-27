# ADR-038: Self-hosted ClickStack + Langfuse (ops observability)

**Status:** Accepted | **Date:** 2026-09-21 | **Updated:** 2026-09-26 | **Tags:** observability, railway, clickhouse, langfuse, hyperdx, otel

### Context

Hosted observability was Langfuse Cloud plus unused Better Stack and Amplitude. Product Railway `ctxpipe` clones every service into preview environments, so ClickHouse in that project would copy volumes and still could not share private DNS across environments. Page views and APM were the analytics need.

### Decision

1. **Separate Railway project** `ctxpipe-observability`, with no preview deploys, in region `us-east4-eqdc4a` (same Virginia metal as product Railway and Neon). Internal ops only, under [`ops/observability/`](../../../ops/observability/). Not in the product Terraform module, the product deploy workflow, or the AWS CDK templates. Pin the region after create or apply. Detail: [ops/observability/README.md](../../../ops/observability/README.md).

2. **One ClickHouse** (1 GiB memory cap) shared by HyperDX and Langfuse, databases `otel` and `langfuse`. Detail: [clickhouse/README.md](../../../ops/observability/clickhouse/README.md).

3. **One collector** is the only OTLP ingress. Apps export each signal once. The ClickStack config keeps traces in ClickHouse and routes LLM spans to Langfuse with `filter/llm_only`. A second collector is rejected. [`apps/otel-collector`](../../../apps/otel-collector/) is a laptop debug sink and is not started by self-host deploy.

4. **LLM tracing** is the Langfuse LangChain `CallbackHandler` plus `propagateAttributes` ([ADR-011](ADR-011-backend-observability-otel.md)). Spans leave the process once, on the same OTLP exporter. LangSmith is removed ([ADR-006](ADR-006-langsmith-studio-dev-routes.md)).

5. **Resource attribute** `deployment.environment` follows the [observability skill](../../../.cursor/skills/observability/SKILL.md). The backend flushes PR metrics on demand; codesearch exports traces only on PR. Production keeps a 60s metric reader.

6. **Browser:** `@hyperdx/browser` posts `POST /.otel/v1/$signal` on the same origin. The UI server holds the collector URL and ingest key. Replay is off. Supersedes [ADR-017](ADR-017-amplitude-analytics.md).

7. **Images and apply.** CI-built images pinned by Terraform; applied from [`observability.yaml`](../../../.github/workflows/observability.yaml) on `main`. Detail: [terraform/README.md](../../../ops/observability/terraform/README.md).

8. **Self-hosters** set `OTEL_EXPORTER_OTLP_*` on their own collector. Compose `deploy` and `@ctxpipe/aws-cdk` pass that endpoint through and do not bundle a collector or this stack. Better Stack and Amplitude are removed.

9. **Awake vs sleep.** Production metrics keep the collector and ClickHouse awake. HyperDX sleeps. Nothing polls sleepable services. `railway-telemetry` is a 5-minute cron. Detail: [ops/observability/README.md](../../../ops/observability/README.md) (Awake vs sleep).

### Consequences

- One internal APM and LLM stack. Self-host deploy does not ship it.
- Preview environments can sleep: no periodic metric export and no per-environment collector.
- Cross-project OTLP is public, with an ingest token. Private networking does not cross Railway projects.
- Single-node ClickHouse. A bucket outage at boot keeps it restarting until the bucket answers. Cold-part metadata stays on the volume.
- Langfuse isolation is a second database on the existing Neon project, not a schema on `neondb`.

### Alternatives Considered

- **ClickStack inside `ctxpipe`:** Rejected. Preview volume clones, and private DNS does not cross environments.
- **Keep Amplitude or Better Stack:** Rejected. Both were unused. Browser analytics is HyperDX RUM on the same OTLP path.
- **Keep LangSmith:** Rejected. LLM spans go through Langfuse. Studio routes are gone.
- **Periodic metrics on preview:** Rejected. A 60s export prevents Railway sleep.
- **App-side fan-out or a second collector:** Rejected. One export; the collector routes LLM spans.
- **Bundled collector in self-host or AWS templates:** Rejected. Operators bring an endpoint.
- **Schema on `neondb`:** Rejected. Langfuse Prisma SQL hardcodes `public`.
- **Named ClickHouse storage policy:** Rejected. Tables created without `storage_policy` inherit `default`.
- **Ratio sampler on the Langfuse worker:** Rejected. `write-to-clickhouse` is one long-lived trace.
- **`OTEL_SDK_DISABLED` on HyperDX:** Rejected. It also blocked self-traces.
