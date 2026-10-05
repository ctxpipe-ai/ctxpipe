# End-to-end ingestion validator on popular repositories

Status: ready
Priority: P0
Owner: unassigned
Blocked by: none
Created: 2026-10-01
Updated: 2026-10-05

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

## Follow-ups

- [ ] Define the GPT-6 Luna price in Langfuse before the next paid run. This is an ops step: add a Langfuse model definition for `openai/gpt-6-luna`. Until then, the report shows "cost unknown" for each stage that used Luna.

## Comments

- 2026-10-01 (ticket 07): `graphQualityReport` now reads a Workspace projection (`--org-id --workspace-id`). `repoGraphSizeCheck` still counts legacy `objects` rows, which this branch no longer writes — port it to workspace knowledge units as part of the validator.

- 2026-10-01 (user): estimate too high; start with n8n alone and budget from its measured cost.

- 2026-10-01 (user): the validator runs with the cheaper Luna tiers; standard models stay unchanged. Budget requested — proposal added.

- 2026-10-03 (claude): **Phase 1 — validator built and dry-run; no paid run.**
  - _Updated after adversarial review (same day); this bullet list describes the current validator._ `apps/backend/src/scripts/ingestionValidator.ts` (entry: options and guards) + `ingestionValidatorRun.ts` (run), `ingestionValidatorQueries.ts`, `ingestionValidatorReport.ts`, `ingestionValidatorTelemetry.ts`; shared units helper `apps/backend/src/models/repository-knowledge-units.ts`.
  - Guards: refuses a `production` deployment environment, and a Railway environment on the default OpenWorkflow namespace (before any DB connection). Mode defaults to `index-only` (org must have no Workspace, so ingestion stops after codesearch and makes no LLM call); spending needs `--mode full --workspace-id <ws>`, where `<ws>` must be the org's **only** Workspace. Both are re-checked before every repository, and each extraction run's captured `workspaceId` must equal `<ws>`.
  - Per repository: ensure the repo row; in full mode link it (`link_unlink` write job, polled to `completed`). If an ingestion is already in flight it waits for it, then enqueues its own `fullReingest` with the validator run id as `request.id` (job telemetry carries it to every child, every tip-ahead follow-up, the hydrate, spans, and Langfuse `requestId`). If the enqueue still returns a run without that id, the repo fails as coalesced. It polls every attributed orchestrator run (its own plus follow-ups) to terminal, then the final ingestion's hydrate (`extractionHydrateKey(extractionWriteJobId(run))`), until graph and embedding stores leave `pending`, or the per-repo timeout passes.
  - Checks: `ingestion.attribution` (own run / waited for in-flight / coalesced → FAIL), `ingestion.workflow` (every attributed run, follow-ups included), `ingestion.repository_status` (`complete_with_issues` → WARN). `codesearch.zoekt` (index output + live `f:.` Zoekt search), `codesearch.scip` (detected vs last completed `scip:<lang>` attempt vs expected languages, merge shard count). `extraction.destination`, `extraction.commit` (published SHA equals the write job's; "exactly one commit" is **not** checked against Workspace git history, and the report says so), `extraction.knowledge_files`. `hydrate.projection` (hydrate for that SHA activated); `hydrate.units` / `hydrate.graph` / `hydrate.embeddings` fail unless the published projection is at the extraction commit. `quality.size` (`repoGraphSizeCheck` bounds), `quality.graph` (metrics of the repository's own units; thresholds via `--quality-thresholds`; whole-Workspace metrics reported separately, no thresholds). `telemetry.traces`, `telemetry.llm`, `telemetry.models` (model names from Langfuse generations; WARN on non-Luna chat models).
  - Spend: Langfuse per stage (`identify-roots`, `extract-kind`, `identify` by `repositoryId` + `workflowStepName` metadata; hydrate `embeddings` by `requestId` + generation name) after a bounded wait for counts to stop changing, marked **unverified** until the paid run confirms the query shape. The commit-subject call is not traced in Langfuse; at concurrency 1 the report shows it as "OpenRouter delta − Langfuse total". The OpenRouter key is read before and after each repository at concurrency 1. Above 1, the report says per-repo deltas are unavailable and reads the key once at the start and once at the end.
  - Peak memory and CPU are not measured by this validator. Ticket 05 step 1 instruments them; the report has no placeholder for them.
  - `repoGraphSizeCheck` counts Workspace knowledge units of the repository's latest completed extraction at the published projection (shared helper), not legacy `objects`.
  - Dry run (local worktree DB, OpenWorkflow worker, codesearch container, a made-up org with no Workspace; two tiny public repos):
    `bun run src/scripts/ingestionValidator.ts --org-id <dry-run org> --mode index-only --repos dry-repos.txt --concurrency 2 --timeout-minutes 30 --poll-seconds 5 --out-dir out --run-id val_dryrun_1`
    with `dry-repos.txt` = `octocat/Hello-World`, `octocat/Spoon-Knife`. Exit 0, both **PASS** in ~6 s each: ingestion completed and `ready`; Zoekt searchable (probe matched files); SCIP "indexed none (detected none)"; extraction skipped by design; 3 of 3 runs per repo carry a trace id; OpenRouter key usage delta $0.0000 (read-only `GET /key`). Every run row (orchestrator, ingestion, index) stored the validator run id in its telemetry.
    Re-run after the review fixes (no `--mode`, so index-only by default; `RAILWAY_ENVIRONMENT_NAME=local-validator-dry-run`, `OPENWORKFLOW_NAMESPACE_ID=validator-dry-run`, matching worker): `bun run src/scripts/ingestionValidator.ts --org-id <dry-run org> --repos dry-repos.txt --concurrency 2 --timeout-minutes 30 --poll-seconds 5 --run-id val_dryrun_2`. Exit 0, both PASS (`ingestion.attribution` own run); every run row stored `input.telemetry["request.id"] = val_dryrun_2`. The same command on the default namespace exits 1 with "on Railway the validator needs its own OPENWORKFLOW_NAMESPACE_ID".
    Not exercised by the dry runs (unit and Postgres tests only): link, follow-ups, coalescing, extraction, hydrate, size, quality and Langfuse paths. The Langfuse metrics query shape (`/api/public/metrics`, `metadata` stringObject filters, `providedModelName` dimension, `requestId` on embedding generations) is unverified against the self-hosted Langfuse: check it with the Langfuse MCP before the paid run.
  - **n8n measurement run (plan, needs user approval and inputs):**
    1. Environment: a dedicated Railway environment `ingestion-validator` in project `ctxpipe`, created like a PR preview (`railway environment new ingestion-validator --duplicate production`), with its own Neon branch made from a **schema-only** parent so it holds no production rows. Migrate it with `pnpm db:migrate`, then provision `ctxpipe_app`.
    2. Variables on **backend and worker only**: `MODEL_PROVIDER=openrouter`, `MODEL_PROVIDER_API_KEY=<dedicated key>`, `MODEL_FAST_NAME=openai/gpt-6-luna?reasoning.effort=low`, `MODEL_MEDIUM_NAME=openai/gpt-6-luna?reasoning.effort=medium`, `MODEL_HIGH_NAME=openai/gpt-6-luna?reasoning.effort=high`, and `OPENWORKFLOW_NAMESPACE_ID=ingestion-validator`, because a non-`pr-N` environment otherwise shares the `default` namespace. Keep the OTLP variables, so traces land in HyperDX under `DeploymentEnvironment = ingestion-validator`. Give codesearch the production memory and volume; n8n fits (#368), but linux and kubernetes need a check before the full run.
    3. Run from inside the environment (codesearch is private-network only): `railway ssh --environment ingestion-validator --service backend`, then `cd apps/backend && echo "n8n-io/n8n typescript" > /tmp/n8n.txt && LANGFUSE_AUTH_STRING=… bun run src/scripts/ingestionValidator.ts --org-id <org> --mode full --workspace-id <ws> --repos /tmp/n8n.txt --concurrency 1 --timeout-minutes 240 --out-dir /tmp/val`, then copy the `.json` and `.md` out.
    4. The validator does not cap spend itself. The key's $30 credit limit is the hard stop; the report records usage before and after.
  - **User must provide:** (a) a Railway token, or approval to create the `ingestion-validator` environment and its schema-only Neon branch; (b) a dedicated OpenRouter key with a **$30 credit limit**; (c) a validation org in that environment with a GitHub connection and exactly one Workspace, whose repository is writable by the App (an empty private repo is fine); (d) `LANGFUSE_AUTH_STRING` for the self-hosted Langfuse, and HyperDX access to read traces.
  - Local tooling: `provision-app-role` rejected worktree DB names containing `-`, so `pnpm db:migrate` in such a worktree left `ctxpipe_app` without grants. Fixed: hyphens are now allowed inside the quoted identifier, with a test.

- 2026-10-04 (claude): **Phase 2: validator environment up. The paid run has not started.**
  - The environment is a PR preview, not the hand-built `ingestion-validator` from the plan above. A draft "Ingestion validator environment (do not merge)" PR from branch `validator/ingestion-environment` (PR 280 head) is deployed as Railway `pr-385`. PR Deploy gives it its own Neon branch and OpenWorkflow namespace `preview-pr-385`. Closing that PR tears it all down. A duplicate of production would have kept production's `DATABASE_URL` and the shared namespace.
  - Variables set on `pr-385` only. Backend and worker (`openworkflow`): `MODEL_PROVIDER=openrouter`, `MODEL_PROVIDER_API_KEY` (the dedicated $30 key), `MODEL_FAST_NAME` / `MODEL_MEDIUM_NAME` / `MODEL_HIGH_NAME` (Luna `low` / `medium` / `high`). Backend only: `LANGFUSE_AUTH_STRING`. Each write checked that the environment id resolves to `pr-385`. After the redeploy, `railway ssh` shows the tiers in both containers. The validator reads the key's $30 limit. Model defaults in code, production, and pr-280 are unchanged.
  - Dry run inside the `pr-385` backend: a made-up org with no Workspace, `--mode index-only`, two tiny public repos (`octocat/Hello-World`, `octocat/Spoon-Knife`), run id `val_pr385_dry_1`. Exit 0, both PASS. HyperDX has the run's spans under `pr-385` for backend, codesearch, and openworkflow. OpenRouter key usage was $0 before and $0 after.
  - Langfuse from inside the container: project id resolves, and the metrics query (`metadata` stringObject filters, `providedModelName` dimension) answers with `count_count` / `sum_*Tokens` / `sum_totalCost` keys, which `measure()` matches by suffix. **Langfuse has no price for `openai/gpt-6-luna`** (`sum_totalCost` is null), so its per-stage cost reads $0. Compute per-stage dollars as tokens × OpenRouter Luna prices ($0.10 / M input, $0.50 / M output). The key's usage delta stays the authoritative total. `providedModelName` drops the `?reasoning.effort` suffix, so generations do not show which tier made them.
  - **Repos line fix:** `n8n-io/n8n typescript`. Code search has no `javascript` indexer (JS is covered by `typescript`), so `typescript,javascript` would always fail `codesearch.scip`.
  - Railway SSH does not forward stdin, so secrets go in as `pr-385` service variables, not on the command line. A backend redeploy replaces the container: it wipes `/tmp` and kills a running validator. Launch the run with `nohup` and copy the reports out before any redeploy.
  - Next (user): create a private repository with a README under a GitHub account or org that no production ctx| org uses. Install the production App (`ctxpipe-agent`, which the preview inherits) on it with "Only select repositories". Do not add it to the existing ctxpipe-ai installation. Then: register the installation on the preview org (`POST /{orgSlug}/api/v1/github/installation`), create the Workspace (`POST /{orgSlug}/api/v1/workspaces` with `gitUrl` + `githubConnectionId`), and run inside the backend: `nohup bun run src/scripts/ingestionValidator.ts --org-id <org> --mode full --workspace-id <ws> --repos /tmp/val/n8n.txt --concurrency 1 --timeout-minutes 240 --poll-seconds 30 --out-dir /tmp/val --run-id val_pr385_n8n_1 > /tmp/val/n8n1.log 2>&1 &`.

- 2026-10-05 (claude): **Phase 3: n8n measurement run. Total spend $0.64 of the $30 key. n8n FAILs at the extraction capture cap.**
  - Setup: the user added a private test repository in the company's own GitHub org to the existing App installation. The validation org on `pr-385` registered that installation and has one Workspace on that repository. Bootstrap and hydrate reached `ready`.
  - Runs 1 to 3 failed in seconds and spent nothing. Each one found a defect, fixed with a regression test:
    1. `val_pr385_n8n_1`: the link write job failed with `Unrecognized key: "telemetry"` (trace `4abcf4270ae2410cdee8e13d9071a888`). Each Workspace write workflow re-parses `queuedInput` with its strict schema, and enqueue had added job telemetry. Fix: `defineObservedWorkflow` gives the body its input without `telemetry` and still restores attribution from it.
    2. `val_pr385_n8n_2`: ingestion failed with "There is at least one repository that does not exist or is not accessible to the parent installation" (trace `22cbc556d35af5b918ffa9d2f43e827f`). The link stamped the Workspace's GitHub connection on the public upstream repository row, so ingestion asked the installation for a token it cannot issue. The same happens when a user links a public repository of another account in the product.
    3. `val_pr385_n8n_3`: an attempt to return no token for such a repository hit the deliberate fail-closed guard in `resolveRepositoryReadCredential` ("The connected repository has no read credential", trace `35fe6b4ead4f3c1bd23ed8951d2764c4`). That attempt was dropped. Fix: `ensureOrgRepositoryForGitUrl` binds the connection only when the repository owner is the installation account. It also clears such a binding that an earlier link left.
  - `val_pr385_n8n_4` (`n8n-io/n8n typescript`, `--mode full`, concurrency 1), 20:50 to 21:55 UTC, 64 min 13 s:
    - Codesearch: 475 s. SCIP indexed `typescript` and `python` (detected the same). `codesearch.zoekt` FAILs: the `f:.` probe matched no files. Not yet investigated: a validator probe defect or a real Zoekt gap on a large repository. Trace `cc7c8b5b9366438958b71c0fc8a64006`.
    - Extraction: 3374 s and 545 Luna generations, then the ingestion failed with **`Extraction capture exceeds 8 MiB`** (`extractionCaptureBudgetSchema` in `domain/workspaces/extraction.ts`, "reject rather than truncate"). Nothing was committed, so the hydrate, size, and quality checks did not run. Orchestrator trace `a233af717b2d7c891202cec658f9ecd7`, ingestion trace `68c9e4c0cfa68d626ce7df97b658fc2a`, Langfuse session `repository-ingestion:fb410d19-3739-4641-ae48-b08f3becca54`.
    - Spend per stage. Langfuse gives the tokens; dollars are tokens × Luna prices ($0.10 / M input, $0.50 / M output), because Langfuse has no price for the model:

      | Stage | Calls | Input | Output | Dollars |
      | --- | --- | --- | --- | --- |
      | identify-roots | 5 | 9,686 | 1,199 | $0.002 |
      | extract-kind | 6 | 65,352 | 544 | $0.007 |
      | identify | 534 | 2,729,130 | 750,563 | $0.648 |
      | embeddings (hydrate) | not reached | | | |
      | total | 545 | 2,804,168 | 752,306 | $0.657 |

      The OpenRouter key's usage delta across the repository was $0.611. The key now reads $0.639 in total for runs 1 to 4, setup, and a small amount after the validator's last read. `identify` is 98% of the cost; output (reasoning) tokens are 57% of it.
  - Validator defects:
    - The Langfuse filter `metadata.requestId = <run id>` matches no generation, so the bounded wait for Langfuse ingestion and the hydrate `embeddings` stage read zero. Filtering by `repositoryId` + `workflowStepName` works.
    - The per-stage cost column reads $0 because Langfuse has no price for the Luna model. Compute it from tokens, as in the table above.
  - **Blocker before any further paid run:** the 8 MiB capture cap. Every repository larger than n8n will fail the same way after it has spent its extraction budget. Split the capture (per root or per kind, each its own durable capture and commit), or change the cap with an ADR-047 decision. Do not re-run n8n until then: the run spends about $0.65 and fails at the same point.
  - Proposed budgets (key spend, Luna tiers, 1.5× margin over the n8n measurement, scaled by repository size):
    - Per stage per repository: identify-roots $0.01; extract-kind $0.02; identify about $0.20 per million tokens of extractor input (n8n: 2.7 M input, $0.65); hydrate embeddings at most $0.10, which is not yet measured.
    - Per repository: n8n, react, next.js, ollama $1 each; flutter, golang/go, cpython $2 each; vscode, kubernetes $3 each; linux, tensorflow, rust $4 each. The full set is about $30 at that cap. Use a new key with a $35 limit after the capture fix, one repository at a time first.
  - Wall time for n8n: about 8 min codesearch and 56 min extraction at OpenWorkflow concurrency 6. A 240-minute per-repository timeout is enough for n8n. linux and tensorflow need a measured bound.

## Resolution
