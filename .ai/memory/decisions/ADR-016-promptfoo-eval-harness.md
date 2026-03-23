# ADR-016: Promptfoo eval harness (baseline vs MCP `ctx_advisor`)

**Status:** Accepted | **Date:** 2026-03-23 | **Tags:** evals, promptfoo, mcp, quality

## Context

We need to evaluate how well ctxpipe answers questions against real usage (public repos indexed into an org, user-style prompts) and to benchmark **without** vs **with** the ctxpipe MCP (`ctx_advisor`) in a reproducible way. LLM-as-judge is useful but expensive, so it must not run on every CI push.

## Decision

1. Add a workspace package [`packages/evals`](../../../packages/evals) (`@ctxpipe/evals`) that runs [Promptfoo](https://www.promptfoo.dev/) with:
   - **Baseline provider**: direct OpenAI-compatible chat completions — **questions-only** (no repo text in the baseline prompt by default), no MCP.
   - **MCP provider**: `@modelcontextprotocol/sdk` **streamable HTTP** client calling tool **`ctx_advisor`** — same MCP surface as Cursor/agents.
2. **Pin models** in YAML (`promptfooconfig.yaml` / `promptfooconfig.full.yaml`) for reproducible benchmark numbers; document refresh in `packages/evals/README.md`.
3. **Default** eval config uses **cheap** assertions (`javascript`, `contains`). **`eval:full`** adds a **global** `llm-rubric` with a pinned rubric judge model (extra cost).
4. **CI**: optional [`.github/workflows/evals.yml`](../../../.github/workflows/evals.yml) with **`workflow_dispatch` only** (template; operators supply secrets and a reachable backend). **Not** on PR/push.
5. **Documentation**: this ADR plus [`packages/evals/README.md`](../../../packages/evals/README.md) (runbook, env, public repo table, seeding).

## Consequences

- Operators must run a **live backend** with a **valid Bearer token** and org that has the relevant public repos indexed for `ctx_advisor` tests to be meaningful.
- `pnpm install` may require native builds for Promptfoo’s `better-sqlite3` dependency; see README troubleshooting.
- Baseline is intentionally **harsh** (no org context in prompt); scores are directional, not a claim of equal information access.

## Alternatives considered

- **REST conversation API** (same graph as MCP): simpler client setup, but **rejected** as the canonical benchmark arm — we optimize for **MCP parity** with agents.
- **Braintrust / LangSmith / custom harness**: heavier product integration or more code; Promptfoo gives YAML + multi-provider columns + local reports with less bespoke glue.
- **Committed synthetic demo repos**: rejected — we use **public repos** and document which ones to index; no parallel fake repositories in-repo.

## Notes

- See [`packages/evals/README.md`](../../../packages/evals/README.md) for commands and env vars.
- Related: [ADR-005](ADR-005-langgraph-integration.md) (LangGraph), MCP implementation in `apps/backend/src/mcp/tools.ts`.
