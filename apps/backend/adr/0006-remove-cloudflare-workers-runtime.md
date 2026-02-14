## ADR 0006 - Remove Cloudflare Workers Runtime

- **Status**: Accepted
- **Date**: 2026-02-15

### Context

We originally targeted both Cloudflare Workers and Bun/container (ADR 0001). We are standardising on a single runtime for the backend.

### Decision

Remove all Cloudflare Workers–specific integrations: the worker entrypoint (`src/worker.ts`), Wrangler config (`wrangler.toml`), the `backend-worker` service and `cloudflare` profile in Docker Compose, the `dev:worker` and `build:worker` scripts, and the `.dev.vars.example` template. The backend runs only on Bun (container/on-prem). Hono and application logic are unchanged.

### Reasons

- **Colocating compute with storage**: We need the backend close to Postgres, Neo4j, and future storage. Running on Cloudflare Workers would separate compute from our data and add latency and operational complexity.
- **Simplifying deployments and runtimes**: We need to run full services (databases, LangGraph, subprocesses for Studio, etc.). A single container/VM runtime is simpler than maintaining two stacks (Workers and containers).
- **CF limits**: Cloudflare Workers/containers impose limits (CPU time, memory, no subprocesses) that are too low or incompatible with our full-service needs.

### Consequences

Positive:

- Single runtime to test and deploy; no Wrangler or Worker-specific code or config.
- Simpler local dev: one backend service in Compose, no `.dev.vars` or profile switching.
- ADRs 0001, 0003, 0004, 0005 retain strikethrough of obsolete CF/Worker text and point here for the removal rationale.

Negative / trade-offs:

- We no longer have an edge-deployment option on Cloudflare; if needed later, we would revisit with a new ADR.

### Alternatives Considered

- **Keep Workers as an optional target**: Rejected; maintaining two runtimes and abstractions (e.g. `AppEnv` Bindings/Variables) was not justified given we run full services and need compute colocated with storage.

### Notes

- ADRs 0001, 0003, 0004, and 0005 were updated with strikethrough of Cloudflare/Worker-related text and an “Update” section linking to this ADR.
