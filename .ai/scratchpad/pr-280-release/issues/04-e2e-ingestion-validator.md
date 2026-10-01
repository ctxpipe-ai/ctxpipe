# End-to-end ingestion validator on popular repositories

Status: plan-review
Priority: P0
Owner: unassigned
Blocked by: none
Created: 2026-10-01
Updated: 2026-10-01

## Context

Ingestion on this branch is: repository ingestion (OpenWorkflow) → codesearch index (Zoekt + per-language SCIP) → LLM extraction → captured, typed **git write** into the workspace repository → hydrate projects files into Postgres / FalkorDB / embeddings ([ADR-046](../../../memory/decisions/ADR-046-workspace-revision-projection-identity.md), [ADR-047](../../../memory/decisions/ADR-047-native-durable-write-workflows.md)). Nothing proves this pipeline end-to-end on real, large, polyglot repositories.

Existing tools to reuse: `src/scripts/repoGraphSizeCheck.ts` (graph size vs checkout lower bounds), `src/scripts/graphQualityReport.ts` (join density, orphans, evidence per claim; `--compare`), `src/scripts/reindexRepositories.ts` (full re-ingest enqueue), the cost dashboard (#359), and the hosted observability stack — HyperDX/ClickStack for logs/traces/metrics and Langfuse for LLM traces ([ADR-038](../../../memory/decisions/ADR-038-self-hosted-clickstack-langfuse.md)). OpenWorkflow 0.10 now exports native `workflow_run` / `step_attempt` spans (#364).

Model tiers come from `MODEL_FAST_NAME` / `MODEL_MEDIUM_NAME` / `MODEL_HIGH_NAME` (`apps/backend/src/retrieval/services/modelProvider.ts`). Defaults today: fast `openai/gpt-6-luna?reasoning.effort=high`, medium `…effort=xhigh`, high `xiaomi/mimo-v2.6-pro`. Most extractors use `medium`; root identification uses `fast`.

## Goal

A repeatable validator that ingests a fixed set of popular repositories into a workspace on a hosted environment, checks every stage against explicit expectations, and records full traces — and every repository in the set passes.

## Acceptance criteria

- [ ] Models switched to GPT-6 Luna for all tiers before the run: fast `openai/gpt-6-luna?reasoning.effort=low`, medium `…=medium`, high `…=high`.
- [ ] Validator script (`apps/backend/src/scripts/ingestionValidator.ts` or similar) takes a repository list and an environment, enqueues ingestion, waits, and emits a per-repo report: stage timings, codesearch status (Zoekt, each SCIP language, issues), extraction commit SHA in the workspace repo, hydrate projection SHA/state, graph size check, graph quality metrics, LLM token/cost totals, failures with trace ids.
- [ ] Traces for every run are in HyperDX (filter `DeploymentEnvironment` + a validator `run.id` attribute) and LLM calls in Langfuse; the report links them.
- [ ] All repositories in the set reach `PASS` (or a documented, user-accepted exception).
- [ ] Every failure found becomes a fix commit with a regression test, or a follow-up ticket.
- [ ] Baseline numbers (wall time, peak memory, CPU, tokens, cost per repo) saved as the input for ticket 05.

## Repository set (proposed — confirm)

10 most-starred *code* repositories (excluding lists/curricula), chosen to cover the SCIP language matrix, plus the two requested:

| Repo | Why |
| --- | --- |
| facebook/react | JS/TS monorepo |
| vercel/next.js | Large TS + Rust monorepo |
| microsoft/vscode | Very large TS |
| tensorflow/tensorflow | C++/Python, huge |
| flutter/flutter | Dart |
| golang/go | Go |
| rust-lang/rust | Rust, huge |
| python/cpython | C/Python |
| ollama/ollama | Go, mid-size |
| torvalds/linux | C, size stress test |
| n8n-io/n8n | Requested; TS monorepo, known scale issues (#368) |
| kubernetes/kubernetes | Requested; Go, very large |

## Plan

1. **Environment.** Use the pr-280 Railway preview (traces land in HyperDX with `DeploymentEnvironment=pr-280`). Set the three Luna tier env vars on backend + worker. Confirm codesearch volume and memory limits are large enough for linux/kubernetes or note expected limits.
2. **Validator script.** Inputs: org, workspace, repo list (`--repos file`), concurrency (default 1–2), timeout per repo. For each repo: link it to the validation workspace, enqueue full ingestion, poll native OpenWorkflow + repository status until terminal, then collect checks:
   - codesearch: Zoekt shards present, SCIP languages expected vs indexed, `complete_with_issues` reasons;
   - extraction: typed extract job committed exactly one commit to the workspace repo; knowledge files parse;
   - hydrate: projection active at that SHA; Postgres units count > 0; graph published; embeddings fresh;
   - quality: `repoGraphSizeCheck` bounds, `graphQualityReport` metrics vs thresholds;
   - telemetry: run/trace ids, stage durations from spans, token + cost totals.
   Writes `validator-<run-id>.json` + a Markdown summary. Stamps `ctxpipe.validator.run_id` attribution on every enqueue so all spans are filterable.
3. **Dry run** on two small repos (ollama, react) to validate the harness itself.
4. **Full run**, one repo at a time first (clean attribution), then a 2-way concurrent pass.
5. **Fix loop.** Triage each failure: pipeline bug → fix + regression test (prefer native contract tests); infra limit → ticket 05 or an infra change; model quality → prompt/extractor fix with a quality-report diff. Re-run only failed repos, then the full set once at the end.
6. **Record** the final report and baseline numbers in `## Resolution`; hand traces to ticket 05.

## Open questions

- Is the Luna low/medium/high tier switch for this run only (env on the preview), or should it become the code default?
- Confirm the repository set; do you want linux and tensorflow (very large) in the pass criteria, or as stress tests that may "pass with issues"?
- Budget ceiling for LLM spend on the full run?
- Pass thresholds for quality metrics — use current `graphQualityReport` values on a known-good repo as the bar?

## Delegation brief

Read first: this ticket, `repository-ingestion.ts`, `repository-index.ts`, `workspace-extract-ingest.ts`, hydrate workflow, the three scripts in `apps/backend/src/scripts/`, `modelProvider.ts`, `.cursor/skills/observability/`, `.cursor/skills/use-railway/`, ADR-038.

Needs: pr-280 access (Railway token), HyperDX + Langfuse access, a validation org/workspace with a writable GitHub workspace repository. Do not change production env vars. Report per-repo status, the worst failures with trace links, and the fixes landed.

## Comments

## Resolution
