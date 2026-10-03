# End-to-end ingestion validator on popular repositories

Status: ready
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

- 2026-10-01 (ticket 07): `graphQualityReport` now reads a Workspace projection (`--org-id --workspace-id`). `repoGraphSizeCheck` still counts legacy `objects` rows, which this branch no longer writes — port it to workspace knowledge units as part of the validator.

- 2026-10-01 (user): estimate too high; start with n8n alone and budget from its measured cost.

- 2026-10-01 (user): the validator runs with the cheaper Luna tiers; standard models stay unchanged. Budget requested — proposal added.

- 2026-10-03 (claude): **Phase 1 — validator built and dry-run; no paid run.**
  - `apps/backend/src/scripts/ingestionValidator.ts` (+ `ingestionValidatorQueries.ts`, `ingestionValidatorReport.ts`, `ingestionValidatorTelemetry.ts`). Per repository: ensure the repo row, link it to the Workspace (a `link_unlink` write job, polled to `completed`), enqueue `enqueueRepositoryIngestionWorkflow({ fullReingest: true })` inside an attribution bag holding `ctxpipe.validator.run_id`, then poll the native run tree (`openworkflow.workflow_runs` / `step_attempts`, recursive through child-workflow steps) until the orchestrator is terminal, then the hydrate run (idempotency key `wjob_<repository-ingestion run>_extract:hydrate`) and until graph/embedding stores leave `pending`, or the per-repo timeout passes.
  - Checks: `ingestion.workflow`, `ingestion.repository_status` (`complete_with_issues` → WARN); `codesearch.zoekt` (index output + a live `f:.` search through Zoekt), `codesearch.scip` (detect-languages output vs each `scip:<lang>` last completed attempt vs expected languages from the repos file, merge shard count); `extraction.commit` (extract run committed, write job records the same SHA, exactly one `commit` step), `extraction.knowledge_files` (every `knowledgePaths` file projected as a unit, none in hydrate diagnostics); `hydrate.projection` (hydrate for that SHA activated), `hydrate.units`, `hydrate.graph`, `hydrate.embeddings`; `quality.size` (`repoGraphSizeCheck` bounds from codesearch `/tree` paths vs unit kinds), `quality.graph` (`computeWorkspaceGraphQuality`, thresholds via `--quality-thresholds`); `telemetry.traces`, `telemetry.llm`. Report adds stage timings from native timestamps (codesearch, extraction, write, hydrate, total), per-step timings with attempts, trace ids from `workflow_run.create` traceparents, HyperDX search links filtered by run id, Langfuse session links, per-stage Langfuse tokens/cost (`identify-roots`, `extract-kind`, `identify`; by `repositoryId` + `workflowStepName` metadata), and OpenRouter key usage before/after each repository (exact at concurrency 1). Writes `validator-<run-id>.json` and `.md`; exit 1 on FAIL/TIMEOUT.
  - Attribution: `ctxpipe.validator.run_id` added to the job-telemetry keys, so every child run's input carries it and `restoreJobTelemetry` puts it on execution, step, fetch and LLM spans; Langfuse trace metadata gains `validatorRunId`.
  - `repoGraphSizeCheck` now counts Workspace knowledge units of the repository's latest completed extraction (`--org-id --workspace-id --repository-id`), not legacy `objects`.
  - `--mode index-only` (no `--workspace-id`) refuses an org that has any Workspace; with no extraction destination, ingestion stops after codesearch, so no LLM call can run.
  - Dry run (local worktree DB, OpenWorkflow worker, codesearch container, a made-up org with no Workspace; two tiny public repos):
    `bun run src/scripts/ingestionValidator.ts --org-id <dry-run org> --mode index-only --repos dry-repos.txt --concurrency 2 --timeout-minutes 30 --poll-seconds 5 --out-dir out --run-id val_dryrun_1`
    with `dry-repos.txt` = `octocat/Hello-World`, `octocat/Spoon-Knife`. Exit 0, both **PASS** in ~6 s each: ingestion completed and `ready`; Zoekt searchable (probe matched files); SCIP "indexed none (detected none)"; extraction skipped by design; 3 of 3 runs per repo carry a trace id; OpenRouter key usage delta $0.0000 (read-only `GET /key`). Every run row (orchestrator, ingestion, index) stored `input.telemetry["ctxpipe.validator.run_id"] = val_dryrun_1`. Not exercised by the dry run (covered by unit and Postgres tests only): link, extraction, hydrate, size, quality and Langfuse paths. The Langfuse metrics query shape (`/api/public/metrics`, `metadata` stringObject filters) is unverified against the self-hosted Langfuse: check it with the Langfuse MCP before the paid run.
  - **n8n measurement run (plan, needs user approval and inputs):**
    1. Environment: a dedicated Railway environment `ingestion-validator` in project `ctxpipe`, created like a PR preview (`railway environment new ingestion-validator --duplicate production`), with its own Neon branch made from a **schema-only** parent so it holds no production rows. Migrate it with `pnpm db:migrate`, then provision `ctxpipe_app`.
    2. Variables on **backend and worker only**: `MODEL_PROVIDER=openrouter`, `MODEL_PROVIDER_API_KEY=<dedicated key>`, `MODEL_FAST_NAME=openai/gpt-6-luna?reasoning.effort=low`, `MODEL_MEDIUM_NAME=openai/gpt-6-luna?reasoning.effort=medium`, `MODEL_HIGH_NAME=openai/gpt-6-luna?reasoning.effort=high`, and `OPENWORKFLOW_NAMESPACE_ID=ingestion-validator`, because a non-`pr-N` environment otherwise shares the `default` namespace. Keep the OTLP variables, so traces land in HyperDX under `DeploymentEnvironment = ingestion-validator`. Give codesearch the production memory and volume; n8n fits (#368), but linux and kubernetes need a check before the full run.
    3. Run from inside the environment (codesearch is private-network only): `railway ssh --environment ingestion-validator --service backend`, then `cd apps/backend && echo "n8n-io/n8n typescript,javascript" > /tmp/n8n.txt && LANGFUSE_AUTH_STRING=… bun run src/scripts/ingestionValidator.ts --org-id <org> --workspace-id <ws> --repos /tmp/n8n.txt --concurrency 1 --timeout-minutes 240 --out-dir /tmp/val`, then copy the `.json` and `.md` out.
    4. The validator does not cap spend itself. The key's $30 credit limit is the hard stop; the report records usage before and after.
  - **User must provide:** (a) a Railway token, or approval to create the `ingestion-validator` environment and its schema-only Neon branch; (b) a dedicated OpenRouter key with a **$30 credit limit**; (c) a validation org in that environment with a GitHub connection and a Workspace whose repository is writable by the App (an empty private repo is fine); (d) `LANGFUSE_AUTH_STRING` for the self-hosted Langfuse, and HyperDX access to read traces.
  - Local tooling note: `provision-app-role` rejects worktree DB names containing `-`, so `pnpm db:migrate` in a worktree whose branch name has hyphens leaves `ctxpipe_app` without grants. For this dry run the grants were applied by hand; the script itself is unchanged.

## Resolution
