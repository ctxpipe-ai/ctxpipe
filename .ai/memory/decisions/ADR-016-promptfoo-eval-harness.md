# ADR-016: Promptfoo eval harness (baseline vs MCP `ctx_advisor`)

**Status:** Accepted | **Date:** 2026-03-23 | **Tags:** evals, promptfoo, mcp, quality

## Context

We need to evaluate how well ctxpipe answers questions against real usage (benchmark org corpus, user-style prompts) and to benchmark **without** vs **with** the ctxpipe MCP (`ctx_advisor`) in a reproducible way. LLM-as-judge is useful but expensive, so it must not run on every CI push.

## Decision

1. Add a workspace package [`packages/evals`](../../../packages/evals) (`@ctxpipe/evals`) that runs [Promptfoo](https://www.promptfoo.dev/) only — **no** parallel non-Promptfoo eval suite. Two pipelines:
   - **Retrieval**: baseline vs MCP (`ctx_advisor`), **pre-ingested** corpus — **Baseline**: OpenAI-compatible chat via **OpenRouter**, questions-only (no repo text in the baseline prompt by default), no MCP. **MCP arm**: `@modelcontextprotocol/sdk` **streamable HTTP** client calling **`ctx_advisor`** (same surface as Cursor/agents).
   - **Ingestion**: post-ingest **state quality** (Promptfoo-driven; details and commands in README).
2. **Benchmark corpus**: standardize on the **[better-auth](https://github.com/better-auth/better-auth)** org (indexed into a ctxpipe org) rather than ad hoc public repos.
3. **Providers / pins**: eval LLMs via **OpenRouter**; **`llm-rubric`** judge uses **Gemini 3 Flash** with a **pinned provider slug** in YAML. Cheap defaults (`javascript`, `contains`); **`eval:full`** enables the global rubric (extra cost). Pin models in `promptfooconfig.yaml` / `promptfooconfig.full.yaml`; refresh cadence in README.
4. **CI**: optional [`.github/workflows/evals.yml`](../../../.github/workflows/evals.yml) with **`workflow_dispatch` only** (operators supply secrets and a reachable backend). **Not** on PR/push.
5. **Documentation**: this ADR for decisions; [`packages/evals/README.md`](../../../packages/evals/README.md) owns runbook, env, seeding, and commands.

## Consequences

- Operators need a **live backend**, **valid Bearer token**, and an org with the **better-auth** corpus indexed for meaningful retrieval/MCP and ingestion runs.
- **OpenRouter** (eval LLMs) and **Gemini 3 Flash** (rubric judge) are separate cost/secret surfaces; slug pins must stay in sync when bumping judge models.
- Two pipelines share Promptfoo config/reporting patterns but measure different things (retrieval arms vs post-ingest quality); comparing scores across pipelines is not automatic.
- `pnpm install` may require native builds for Promptfoo’s `better-sqlite3` dependency; see README troubleshooting.
- Baseline retrieval is intentionally **harsh** (no org context in prompt); scores are directional, not equal information access vs MCP.

## Alternatives considered

- **REST conversation API** (same graph as MCP): simpler client setup, but **rejected** as the canonical benchmark arm — we optimize for **MCP parity** with agents.
- **Braintrust / LangSmith / custom harness**: heavier product integration or more code; Promptfoo gives YAML + multi-provider columns + local reports with less bespoke glue.
- **Committed synthetic demo repos**: rejected — we use a **single documented corpus** (better-auth org); no parallel fake repositories in-repo.

## Notes

- See [`packages/evals/README.md`](../../../packages/evals/README.md) for commands and env vars.
- Related: [ADR-005](ADR-005-langgraph-integration.md) (LangGraph), MCP implementation in `apps/backend/src/mcp/tools.ts`.
