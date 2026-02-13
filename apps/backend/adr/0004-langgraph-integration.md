## ADR 0004 - LangGraph + LangChain Integration via Open LangGraph Server

- **Status**: Superseded
- **Date**: 2026-02-13

### Context

We need LangGraph/LangChain for agent orchestration in the backend. Requirements:

- OpenRouter as default model provider; configurable for on-prem (fast/medium/high tiers).
- LangSmith / LangGraph Studio must be able to connect and interact with our graph API.
- ADR 0001 reserved LangGraph in `platform/`; we prefer in-process integration over a separate server.
- All endpoints should live inside the Hono app (single entry point).

### Decision

We will:

1. Use `@langgraph-js/pure-graph` and its Hono adapter (Open LangGraph Server).
2. Mount the LangGraph API under `/langgraph` inside the existing Hono app (no separate process).
3. Use OpenRouter as default provider; model IDs as code constants (fast: MiMo V2 Flash, medium: Gemini 3 Flash, high: GLM-5) — later DB.
4. Storage: PostgreSQL via `DATABASE_URL` (or in-memory for dev). No SQLite.
5. LangGraph is supported only in Bun/container runtime (no Workers support in this phase).

### Consequences

- Single process, single port; no proxy or subprocess.
- All endpoints in one Hono app; Studio uses `baseUrl=…/langgraph`.
- Depends on community package `@langgraph-js/pure-graph` (not official LangChain Agent Server).

### Alternatives Considered

- Official LangChain Agent Server + proxy: Rejected to avoid a separate server process.
- Custom implementation of the Agent Server API: Rejected due to scope and maintenance burden.

### Notes

- **Update (2026-02)**: `@langgraph-js/pure-graph` was removed due to bugs (missing GET /assistants/{id}, xray query param validation). LangChain/LangGraph, models, and graphs remain in place; Hono–LangGraph integration to be revisited with a different approach.
