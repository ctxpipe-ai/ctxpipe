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

- [ ] The validator runs with GPT-6 Luna on every tier — fast `openai/gpt-6-luna?reasoning.effort=low`, medium `…=medium`, high `…=high` — set only in the validator environment. Standard model defaults in code, production, and pr-280 are unchanged.
- [ ] Spend is measured per repo and stage; every run uses a dedicated OpenRouter key whose credit limit is the approved cap.
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

1. **Environment.** A dedicated Railway environment for validation (e.g. `ingestion-validator`, created like PR previews from the same config), so standard models stay untouched everywhere else. Set the three Luna tier variables and a dedicated OpenRouter key (credit limit = budget) on its backend + worker only. Traces land in HyperDX under that environment's `DeploymentEnvironment`. Confirm codesearch volume and memory are large enough for linux/kubernetes, or note expected limits.
2. **Validator script.** Inputs: org, workspace, repo list (`--repos file`), concurrency (default 1–2), timeout per repo. For each repo: link it to the validation workspace, enqueue full ingestion, poll native OpenWorkflow + repository status until terminal, then collect checks:
   - codesearch: Zoekt shards present, SCIP languages expected vs indexed, `complete_with_issues` reasons;
   - extraction: typed extract job committed exactly one commit to the workspace repo; knowledge files parse;
   - hydrate: projection active at that SHA; Postgres units count > 0; graph published; embeddings fresh;
   - quality: `repoGraphSizeCheck` bounds, `graphQualityReport` metrics vs thresholds;
   - telemetry: run/trace ids, stage durations from spans, token + cost totals.
   Writes `validator-<run-id>.json` + a Markdown summary. Stamps `ctxpipe.validator.run_id` attribution on every enqueue so all spans are filterable.
3. **n8n measurement run.** Run the validator on n8n only (key limit $30). Validate the harness, fix what it finds, record tokens/cost per stage, and propose the budget for the remaining repos from that measurement. Stop for user approval.
4. **Full run** after budget approval, one repo at a time first (clean attribution), then a 2-way concurrent pass.
5. **Fix loop.** Triage each failure: pipeline bug → fix + regression test (prefer native contract tests); infra limit → ticket 05 or an infra change; model quality → prompt/extractor fix with a quality-report diff. Re-run only failed repos, then the full set once at the end.
6. **Record** the final report and baseline numbers in `## Resolution`; hand traces to ticket 05.

## Budget

GPT-6 Luna on OpenRouter: $0.10 per million input tokens, $0.50 per million output tokens (reasoning bills as output).

Decided (user, 2026-10-01): **measure first.** Run n8n alone, record its exact token and dollar cost per stage, then set the budget for the rest from that measurement. The n8n run uses a dedicated OpenRouter key with a **$30 credit limit** as a hard stop (estimate for n8n: $5–15). After the run, extrapolate per-repo cost from repository size (files, packages, languages) and propose caps for the full set for approval.

## Open questions

- Confirm the repository set; do you want linux and tensorflow (very large) in the pass criteria, or as stress tests that may "pass with issues"?
- Approve the budget proposal produced after the n8n run.
- Pass thresholds for quality metrics — use current `graphQualityReport` values on a known-good repo as the bar?

## Delegation brief

Read first: this ticket, `repository-ingestion.ts`, `repository-index.ts`, `workspace-extract-ingest.ts`, hydrate workflow, the three scripts in `apps/backend/src/scripts/`, `modelProvider.ts`, `.cursor/skills/observability/`, `.cursor/skills/use-railway/`, ADR-038.

Needs: a Railway token for the validator environment, a dedicated OpenRouter key with a credit limit, HyperDX + Langfuse access, a validation org/workspace with a writable GitHub workspace repository. Never change model defaults in code, production, or pr-280. Report per-repo status, the worst failures with trace links, and the fixes landed.

## Comments

- 2026-10-01 (user): estimate too high; start with n8n alone and budget from its measured cost.

- 2026-10-01 (user): the validator runs with the cheaper Luna tiers; standard models stay unchanged. Budget requested — proposal added.

## Resolution
