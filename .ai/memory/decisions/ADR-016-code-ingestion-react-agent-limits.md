# ADR-016: Code ingestion ReAct agents — recursion limits and context middleware

**Status:** Accepted | **Date:** 2026-02-15 | **Tags:** backend, langchain, langgraph, code-ingestion, agents

## Context

Repository ingestion uses LangChain `createAgent` (ReAct) inside several `codeIngestionGraph` nodes. Those agents share repo explorer tools and can run long tool-heavy loops. The parent `codeIngestionGraph.invoke` uses a high `recursionLimit` (1000) as a safety backstop; inner agent graphs could inherit a similarly large effective budget, and context middleware defaults (very high token triggers) meant ingestion rarely cleared or summarized tool transcripts before context grew huge.

## Decision

1. **Extend `createAgent`** (`apps/backend/src/graphs/createAgent.ts`) with optional `contextMiddleware` fields. When **omitted**, behavior matches the previous defaults (380k / 520k approximate token triggers) so **conversation** agents are unchanged.

2. **Code-ingestion nodes** pass **tailored** `contextMiddleware` values per extractor (still quality-oriented: mid–high five- and six-digit triggers, not aggressive micro-budgets).

3. **Replace `agent.stream` with `agent.invoke`** in ingestion nodes and pass an explicit **`recursionLimit`** on each call so inner agent graphs do not implicitly piggyback on the parent LangGraph limit. Limits are **per task** (e.g. ~100 for `identifyRoots`, ~180–220 for broad explorers).

4. **Prompt nudges:** system prompts add “prefer submit\_\* once evidence is clear” without hard numeric caps in prose.

5. **Observability:** warn when an agent finishes without capturing submissions where that is actionable (empty `submit_*` capture).

6. **Tool output:** `toToon` in `agentToolRuntime.ts` truncates serialized tool payloads beyond **400k** characters with a plain-text suffix (pathological Zoekt/API responses).

7. **Outer graph:** keep `codeIngestionGraph.invoke` **`recursionLimit: 1000`** unchanged for now (see `openworkflow/repository-ingestion.ts`).

## Consequences

- Ingestion runs should **fail less often** from unbounded ReAct loops and **spend fewer tokens** on redundant tool history once triggers fire.
- **Quality-first:** limits remain **high**; tuning is expected via Langfuse traces.
- **Tradeoff:** a pathological model run may still hit caps; warnings and partial empty captures make that visible.

## Alternatives Considered

- **New runner abstraction** wrapping `invoke`: Rejected; call sites pass config explicitly.
- **Only global recursion limit:** Rejected; inner agents need their own cap independent of the outer graph.
- **Very low recursion limits:** Rejected in favor of extraction quality.

## Notes

- Broader LangGraph usage remains as in [ADR-005](ADR-005-langgraph-integration.md) (superseded stack details) and [ADR-006](ADR-006-langsmith-studio-dev-routes.md) (Studio routing).
