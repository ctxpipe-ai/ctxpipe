# Ingestion performance from validator traces

Status: in-progress
Priority: P1
Owner: claude
Blocked by: 04
Created: 2026-10-01
Updated: 2026-10-10

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

- None. The team lead answered both questions (see Comments, 2026-10-10).

## Delegation brief

Read first: ticket 04's resolution and report, `.cursor/skills/observability/`, `repository-ingestion.ts`, `repository-index.ts`, codesearch `src/domain/indexing/`, hydrate workflow, ADR-027 (codesearch concurrency). Use HyperDX builder tools (`clickstack_table`, `clickstack_timeseries`, `clickstack_trace_waterfall`) before SQL.

Do not trade quality for speed silently: every change reports validator status and a quality-report diff.

## Comments

- 2026-10-10 (team lead, decisions):
  - Priority when goals conflict: 1) peak memory and no OOM, 2) wall time, 3) LLM cost.
  - Scope: code and committed config only. No bigger instances and no more workers. When the data shows that only infra can fix a bottleneck, write it down as a recommendation with its cost.
  - Targets: the proposal is accepted. Median wall time -30%, peak memory -30% on the 3 largest repositories, no new OOMs, validator 100% PASS, and no quality regression in `graphQualityReport --compare`.

- 2026-10-10 (claude): **Profile, bottlenecks, and two code changes. No validator re-run yet.**
  - Baseline. Ticket 04 has one paid run: `val_pr385_n8n_4` (n8n, 64 min, failed at the old 8 MiB capture cap, which ticket 14 removed). Its timestamps are 2026-10-04 20:50 to 21:55 UTC (ticket 04 says 10-05). HyperDX keeps its codesearch and OpenWorkflow spans; Langfuse keeps the 545 generations (trace `9b7e2778d1f77978cf76c30b85f6c936`). No other baseline exists. A new local baseline is not possible: full mode needs a Workspace on a writable GitHub repository (GitHub App credentials) and an approved model key, and the local stack has neither.
  - Critical path of n8n (wall time):

    | Stage | Wall | Notes |
    | --- | --- | --- |
    | clone + checkout | 7 s | |
    | Zoekt | 8 s | |
    | SCIP TypeScript | about 470 s | 97 projects, one at a time, 8 GiB heap each; largest `packages/nodes-base` 83 s, one project 118 s |
    | merge SCIP | 3 s | |
    | identify-roots | 18 s | 5 calls |
    | extract-kind + identify, 6 roots, 2 at a time | 3310 s | 3 waves of 850 s to 1205 s |
    | git write, hydrate | not reached | |

  - Ranked bottlenecks (wall time x frequency):
    1. **Instruction-unit extraction, about 80% of the run.** Each root sent its instruction files to the model one at a time, and each of the 6 package roots extracted the same 31 repo-root files (`AGENTS.md`, `CLAUDE.md`, `.agents/skills/**`, `CONTRIBUTING.md`, `README.md`) again. 186 of 193 calls were copies. The root spans were almost all instruction-unit time (for example 850 s span, 847 s of instruction calls). These calls made 677k of the 736k output tokens. Fixed (commit 1).
    2. **SCIP TypeScript projects run one at a time (about 470 s).** More parallel projects would raise peak memory, which is priority 1. Not changed. Next step: read `scip.process.max_rss_mb` per project (commit 2) on the next run. If small projects use little memory, a size-based admission can run them two at a time.
    3. **Codesearch `glob` calls during extraction:** 82 calls over 1 s, 189 s in total, 2 to 3.6 s each on n8n. They run in parallel with model calls, so they are not on the critical path after fix 1.
    4. **Model-call stalls:** 5 instruction-unit calls took 250 s to 603 s; one of them returned 18 output tokens after 603 s. The model client has no request timeout. Not changed: legitimate 10k-token outputs take about 300 s, so a timeout needs data from more runs.
  - Instrumentation gaps: SCIP subprocess memory and CPU (fixed, commit 2); worker process RSS and CPU per OpenWorkflow step; git write and hydrate phases (not reached by any run). The Langfuse `requestId` filter defect from ticket 04 still applies.
  - Commit 1, `Extract repo-root instruction files once per ingestion, four files at a time`. Only the first root in path order reads the repo-root instruction files (no root does when the run has a `./` root). The files of a root run four at a time, in file order. The capture row of that root is named `<root>#repo-root`, so a run with another root set does not reuse a row with the wrong files. Replay of the n8n trace: identify phase 3310 s to about 650 s (dedupe only: 1170 s); 155 fewer model calls; 559k of 736k output tokens removed (about $0.29 at Luna prices). Proof: `extractInstructionUnits.calls.test.ts` (msw codesearch and model; red before: 8 calls instead of 5, one call in flight), `runExtractRoot.test.ts`.
  - Commit 2, `Record peak memory and CPU time of each SCIP indexer process`: span `scip.indexer.process` with `scip.process.max_rss_mb`, `scip.process.cpu_ms`, `process.exit.code`. The span records the exception and has ERROR status when the indexer does not start or exits with a non-zero code. Proof: `scipIndexers.resources.test.ts` (red before), native Bun contract green.
  - Projection for n8n: 64 min to about 20 min (-65%). Peak memory: no change expected and no data yet. LLM cost: about -45% of the key spend.
  - Next (needs the team lead): a paid validator run on `pr-385` after deploy of this branch, n8n first, then the full set. Then compare with `graphQualityReport --compare`. Commit 1 removes copies of the same units only (same deduplication keys), so the graph should not change. The run also gives the SCIP memory data for bottleneck 2.

- 2026-10-10 (claude, review round 1 fixes):
  - Skills: a package root that skips the repo-root files makes no Skills in its own run. When the write job loads the capture, `deriveSharedRepoRootSkills` derives the Skills of each such root from its units and the repo-root units, as before. A test compares the Skill keys and member claims with the old behavior.
  - Owner: the workflow computes `repoRootInstructionOwner(roots)` once and gives each root `ownsRepoRootInstructions`.
  - In-flight runs: when the `<root>#repo-root` row is missing, the loader reads the plain row name, which a run from before this change stored.
  - SCIP span: ERROR status and exception on a failed start or a non-zero exit; attribute names as above.

## Resolution
