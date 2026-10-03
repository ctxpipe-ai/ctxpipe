# Ingestion performance from validator traces

Status: plan-review
Priority: P1
Owner: unassigned
Blocked by: 04
Created: 2026-10-01
Updated: 2026-10-01

## Context

Ticket 04 produces traces (HyperDX: OpenWorkflow `workflow_run` / `step_attempt` spans, HTTP and DB spans, codesearch phases; Langfuse: LLM calls) and per-repository baselines for wall time, peak memory, CPU, tokens, and cost across 12 large repositories. Known pressure points from `main`: OOM on SCIP and ingest (#286, #290), index admission capacity (#329), size-based codesearch concurrency (#305, ADR-027), giant claim `IN` refetch (#368), per-project TypeScript indexing (#371). On this branch, extraction output also flows through a captured git write and hydrate.

## Goal

Measurably reduce ingestion wall time, peak memory, and CPU on the ticket 04 set, guided by traces, without lowering validator pass rate or graph quality.

## Acceptance criteria

- [ ] Profile report: for each repo, critical path by stage (clone, Zoekt, each SCIP language, extraction per root/kind, git write, hydrate, graph publish, embeddings) with wall time, CPU, peak RSS, LLM time, queue/wait time.
- [ ] Top bottlenecks ranked by total wall time × frequency, each with a hypothesis and a trace link.
- [ ] Targets agreed with the user per metric (proposal: −30% median wall time, −30% peak memory on the 3 largest repos, no new OOMs).
- [ ] Each optimization lands separately with before/after numbers from a validator re-run on the affected repos, and a regression test or benchmark where it is code-level.
- [ ] Validator full set still 100% PASS; `graphQualityReport --compare` shows no quality regression.
- [ ] Final before/after table in `## Resolution`.

## Plan

1. **Instrument gaps first.** From ticket 04 traces, list stages without spans or resource metrics (expected gaps: SCIP subprocess CPU/RSS, git pack/write steps, hydrate parse/activation, embedding batches, the 26 workflows without attribution — see [main-intent-carry.md](../main-intent-carry.md)). Add spans/metrics (process RSS + CPU per step, subprocess peak RSS) where missing. Re-run 2–3 repos to get a complete profile.
2. **Build the profile report** with ClickStack queries (saved as a HyperDX dashboard): per-stage duration percentiles, per-stage CPU/RSS, idle/queue time between steps, LLM tokens and latency by extractor and model tier.
3. **Rank and pick.** Expected candidates, to be confirmed by data:
   - LLM extraction: parallelism per root, prompt size, tier choice per extractor (Luna low vs medium), caching unchanged roots on re-ingest.
   - SCIP: per-language memory caps and concurrency, monorepo project batching (#371), skipping incidental languages.
   - Claims/objects: apply #368's collapse + bounded batching to the branch's extraction merge and hydrate projection.
   - Git write: shallow packs and chunking cost for very large knowledge trees.
   - Hydrate: batch inserts, graph publish batch size, embedding batching and dedupe.
   - Scheduling: queue waits from OpenWorkflow concurrency limits and worker wake-up on Railway.
4. **Optimize one at a time**, each with its own commit, before/after numbers, and proof.
5. **Re-run the full validator**, compare against the baseline, record final numbers, update ADRs if a limit or default changed.

## Open questions

- Which matters most if they conflict: wall time, peak memory (infra cost/OOM), or LLM cost?
- Are infra changes (bigger codesearch instance, more workers) in scope, or only code changes?

## Delegation brief

Read first: ticket 04's resolution and report, `.cursor/skills/observability/`, `repository-ingestion.ts`, `repository-index.ts`, codesearch `src/domain/indexing/`, hydrate workflow, ADR-027 (codesearch concurrency). Use HyperDX builder tools (`clickstack_table`, `clickstack_timeseries`, `clickstack_trace_waterfall`) before SQL.

Do not trade quality for speed silently: every change reports validator status and a quality-report diff.

## Comments

## Resolution
