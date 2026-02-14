## ADR 0005 - LangSmith Studio Dev Routes

- **Status**: Accepted
- **Date**: 2026-02-14

### Context

We need LangSmith Studio to debug LangGraph workflows during development. ADR 0004 originally used `@langgraph-js/pure-graph` (in-process); that was removed due to bugs. The official LangChain Agent Server via `@langchain/langgraph-cli` is more reliable and feature-complete.

Requirements:

- Studio connects to a single base URL (no separate port for users).
- All graphs in `src/graphs/` should be available; new graphs should be auto-discovered.
- Feature is opt-in and Bun-only ~~(Workers cannot spawn subprocesses)~~.

### Decision

1. **Subprocess + proxy**: When `ENABLE_LANGSMITH === "true"`, the Bun server spawns `@langchain/langgraph-cli dev` as a subprocess and proxies `/langsmith/*` to it. Studio uses `baseUrl=https://localhost:3000/langsmith`.

2. **Dynamic `langgraph.json`**: At startup, scan `src/graphs/*.ts` (excluding `index.ts`), generate `langgraph.json` with one entry per file: `{ [basename]: "./src/graphs/{file}:graph" }`. Convention: each file exports `graph`.

3. **Conditional registration**: LangSmith routes and subprocess are only active when:
   - `ENABLE_LANGSMITH === "true"` in env
   - ~~Running via the Bun entrypoint (`server.ts`), not the Worker~~

4. **Env vars**:
   - `ENABLE_LANGSMITH`: must be `"true"` to enable (default: off)
   - `LANGSMITH_DEV_PORT`: port for the Agent Server (default: 2024)

5. ~~**No Worker support**: The Cloudflare Worker entrypoint does not pass `enableLangSmith` to `createApp()`, so no proxy routes are registered.~~

### Consequences

Positive:

- Single port (3000) for Studio; no separate URL to configure.
- New graphs in `src/graphs/` are picked up on restart without config changes.
- Opt-in; no impact when disabled.

Negative / trade-offs:

- Backend may serve before the Agent Server is ready; Studio may need to retry.
- Subprocess adds complexity and requires `@langchain/langgraph-cli` as devDependency.
- ~~Bun-only; no Studio integration when using the Worker runtime.~~

### Alternatives Considered

- **In-app LangGraph Server**: ADR 0004’s approach with `@langgraph-js/pure-graph`; rejected due to bugs.
- **Separate Compose service for LangGraph**: Would require another container and coordination; spawning from the backend keeps one process to start.

### Notes

- `langgraph.json` is generated at runtime and can be gitignored.
- See `src/langsmith/` for config generation, proxy router, and subprocess logic.
- Studio UI: https://smith.langchain.com/studio/?baseUrl=https://localhost:3000/langsmith (when running with HTTPS in dev).

### Update

Cloudflare Workers support was removed; see [ADR 0006](0006-remove-cloudflare-workers-runtime.md).
