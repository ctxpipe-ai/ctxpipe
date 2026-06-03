# 2026-05-26 — Local agent memory: implementation session

## Outcome

Shipped the local agent memory feature from [ADR-021](../decisions/ADR-021-local-agent-memory-agentmemory-hybrid-mcp-proxy.md) and the [PRD](../../product/2026-05-25-local-memory.md) in a single PR.

- `packages/cli`: `ctxpipe memory {mcp,status,doctor,stop,hook}`; canonical Markdown layer; hydration manifest + sync-on-use delta classifier; AgentMemory supervisor (per-repo `HOME`, dynamic loopback ports, generated `AGENTMEMORY_SECRET`); handwritten JSON-RPC 2.0 MCP server with a policy table; init wizard + `--memory` / `--claude-hooks` flags; auth refresh helper.
- `apps/backend`: generic org-scoped OpenAI-compatible model proxy at `POST /:orgSlug/api/v1/openai/v1/{chat/completions,embeddings}` authenticated by existing `withBearerAuth`. Reuses `MODEL_PROVIDER_*` env. Logs evlog wide events.
- TDD throughout, ~67 cli tests + 8 backend tests, plus a fake AgentMemory fixture and a real `bin/ctxpipe.js memory mcp` stdio test.

## Key decisions made / amended this session

1. **No new token type** (Q1 = A in conversation). CLI's existing Better Auth OAuth bearer is refreshed (`ensureFreshAccessToken`) and shipped directly to AgentMemory as `OPENAI_API_KEY`. ADR-021 §9 amended in-place; the proposed `POST /api/v1/memory/model-token` endpoint is **not** implemented and not needed.
2. **Generic proxy path**: `POST /:orgSlug/api/v1/openai/v1/...` instead of ADR-text's `/api/agentmemory/openai/v1/...`. Matches the backend AGENTS.md convention (org-scoped) and avoids locking the route to AgentMemory specifically.
3. **No MCP SDK dependency** — implemented MCP JSON-RPC 2.0 over stdio by hand (~150 LOC). Keeps the published `ctxpipe` npm package light for `npx`.
4. **Delta classifier floor of 10**: ADR-021 §7's "min(50 files, 10% corpus)" would treat any 1-of-2 edit as a full replace. Added `DELTA_FLOOR = 10` so tiny corpora stay merge-only.
5. **Quota DB table deferred**: ADR-021 mentioned a `model_proxy_usage_daily` Drizzle table. Out of scope here; usage is logged via evlog wide events for now. No new operator env (no `OPENAI_PROXY_*`).

## Patterns / conventions reinforced

- Hand-written deps-free YAML-subset parser for `.ai/memory/**/*.md` frontmatter.
- AgentMemory supervisor secret is kept in memory only — `runtime.json` on disk does **not** contain the secret.
- Markdown-only fallback for `memory_recall` ensures signed-out / no-runtime users still get save+search.
- Hydration manifest lives under `~/.config/ctxpipe/memory/repos/<repo-fingerprint>/`; AgentMemory's `~/.agentmemory` is sandboxed there too via `HOME=` env on the child process.

## Where the code lives

- CLI: [packages/cli/src/memory/](../../packages/cli/src/memory/) plus [program.ts](../../packages/cli/src/program.ts), [commands.ts](../../packages/cli/src/commands.ts), [mcp/mcp-operations.ts](../../packages/cli/src/mcp/mcp-operations.ts), [auth.ts](../../packages/cli/src/auth.ts).
- Backend: [apps/backend/src/routes/v1/openai.ts](../../apps/backend/src/routes/v1/openai.ts).
- Tests: [packages/cli/test/](../../packages/cli/test/), [apps/backend/src/routes/v1/openai.test.ts](../../apps/backend/src/routes/v1/openai.test.ts).
- Fake AgentMemory for tests: [packages/cli/test/memory/fixtures/fake-agentmemory.cjs](../../packages/cli/test/memory/fixtures/fake-agentmemory.cjs).
