# ops/observability

This folder holds only [cost-telemetry](./cost-telemetry/README.md). It runs as a scheduled task of the observability stack.

The observability stack (the collector, ClickHouse, HyperDX, the dashboards and the saved searches) is in the factory repo, `machines/observability`, in the production AWS account ([ADR-061](../../.ai/memory/decisions/ADR-061-hosted-ctxpipe-on-aws-behind-cloudflare.md), decision 25). The old Railway stack, Langfuse and `railway-telemetry` are deleted ([ADR-038](../../.ai/memory/decisions/ADR-038-self-hosted-clickstack-langfuse.md), superseded).

How to read telemetry: [USING.md](./USING.md).
