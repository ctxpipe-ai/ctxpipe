# ADR-006: LangSmith Studio dev routes

**Status:** Accepted | **Date:** 2026-02-14 | **Tags:** backend, langsmith, langgraph, dev

## Context

We need LangSmith Studio to debug LangGraph workflows during development. ADR-005 originally used `@langgraph-js/pure-graph` (in-process); that was removed due to bugs. The official LangChain Agent Server via `@langchain/langgraph-cli` is more reliable and feature-complete.

Requirements:

- Studio connects to a single base URL (no separate port for users).
- All graphs in `src/graphs/` should be available; new graphs should be auto-discovered.
- Feature is opt-in and Bun-only.

## Decision

1. **In-process embedding**: When `ENABLE_LANGSMITH === "true"`, the backend mounts an embedded LangGraph API Hono sub-app at `/langsmith` (no subprocess, no proxy). Studio uses `baseUrl=https://localhost:3000/langsmith`.

2. **Graph source is fixed**: Graphs are registered from `src/graphs/index.ts` exports only, using `./src/graphs/index.ts:{exportName}` specs in-process. No generated `langgraph.json` and no separate graph config input.

3. **Conditional registration**: LangSmith routes are only active when `ENABLE_LANGSMITH === "true"` in env.

4. **Env vars**: `ENABLE_LANGSMITH` must be `"true"` to enable (default: off).

## Consequences

**Positive**

- Single port (3000) for Studio; no separate URL to configure.
- Graph registration is explicit and stable via `src/graphs/index.ts`.
- Opt-in; no impact when disabled.

**Negative / trade-offs**

- LangSmith API initialization now happens inside backend startup/request lifecycle.
- We depend on a small `pnpm patch` surface for `@langchain/langgraph-api` exports.

## Alternatives Considered

- **In-app LangGraph Server**: ADR-005's approach with `@langgraph-js/pure-graph`; rejected due to bugs.
- **Separate Compose service for LangGraph**: Would require another container and coordination; spawning from the backend keeps one process to start.

## Notes

- See `src/routes/langsmith.ts` for embedded API assembly and initialization.
- Studio UI: https://smith.langchain.com/studio/?baseUrl=https://localhost:3000/langsmith (when running with HTTPS in dev).
- Cloudflare Workers support was removed; see [ADR-007](ADR-007-remove-cloudflare-workers-runtime.md).
