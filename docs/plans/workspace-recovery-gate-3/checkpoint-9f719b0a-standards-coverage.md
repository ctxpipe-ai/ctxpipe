# Gate 3 result-owner checkpoint — Standards coverage ledger

## Identity and method

- Base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`
- Target: `9f719b0a5402930d2221358582b1ccd589e74adc`
- Target and merge base resolved exactly. Eleven commits were enumerated. Review used `git diff BASE...TARGET`, `git log BASE..TARGET`, `git show TARGET:path`, `git grep`, and `git ls-tree`; the moving worktree was not used for product-code review.
- Cumulative changed manifest: 693 paths — 58 backend production TypeScript files, 22 backend test TypeScript files, 593 Gate 3 plan/evidence files, and 20 migration/ADR/index/package/lock/patch/config/prior-gate files. Increment from `6b5122c5`: 76 paths.
- Standards sources: root and backend `AGENTS.md`; code-review skill and full Fowler smell baseline; TDD skill and `mocking.md`; ADR-027 and ADR-033; accepted recovery plan and target status. Tool-enforced formatting/type cosmetics were excluded.

## Production surfaces reviewed

- Completed-result projection: final Drizzle schema, RLS policy, FK/cascade and one-row-per-workspace key; generated add/drop transition migrations; owner backfill; migrator ordering; completion hooks; binding comparison; extraction snapshot read.
- Result ownership: payload/type additions, semantic handoff persistence and validation, broker capture, parent/child IDs and run ownership, prepared-candidate replacement, completion/reconciliation and export no-op handling.
- No-op hydration: both pre-conflict and resolved-empty semantic exits; standalone versus child completion; hydrate idempotency and export duplicate removal.
- Provider lifecycle: Docker discovery typing, plan/create split, durable workflow step ordering, replay against the planned provider, resolve/destroy flow.
- Mirror schema: move from workflow to domain and all enqueue/workflow/semantic callers.
- Tests/evidence: bounded-read PostgreSQL lock, repeatable-read cutover, backfill/newer-result/RLS cases, fresh and previous-checkpoint migrations, Files single-owner handoff, mirror binding reset, four modify/delete outcomes plus one hydrate, Docker connectivity loss/recovery, export cutover, backend/UI types and checkpoint status.

## Interface and caller tracing

- `workspaceKnowledgePathState`: production access is confined to `workspace-write-jobs.ts`; owner backfill writes it directly. Runtime queries remain tenant-scoped through `orgSql` and RLS; backfill joins jobs to workspaces on both workspace and org.
- `projectCompletedKnowledgePaths`: private completion hook called by `persistWriteJobStatus`, `persistWriteJobCommitSha`, and `persistMigrationExportNoOp`. Each caller invokes it inside the same `orgSql` transaction after a successful non-completed-to-completed transition. It locks the workspace before reading/upserting state, rejects stale binding identity, merges prior current-binding paths, and does no Git/provider/model I/O.
- `getCompletedKnowledgePaths`: sole production caller is `loadExtractionProjectionSource`; the nested call reuses its repeatable-read org transaction. It selects one workspace-keyed row and ignores SHA/access while retaining workspace, generation, repository URL, connection and default branch identity.
- `backfillKnowledgePathState`: sole production caller is `db/migrate.ts`. Its single `INSERT … SELECT` folds only completed matching-binding maps, uses `updated_at DESC, id DESC` for each key, does not overwrite any existing state, and runs under the owner connection after generated schema migrations and before OpenWorkflow migration/startup.
- Completion functions: traced every production caller across all twelve native workflows and the still-present generic workflow. Nonterminal status updates cannot overwrite completed results; completed replays do not reproject older metadata. Export no-op additionally verifies its exact cutover SHA.
- `persistSemanticHandoff`: sole caller is `captureSemanticHandoff`. Under a job-row lock it requires the running original owner, original revision/mirror and original prepared candidate, then persists the exact refreshed revision and delta.
- `validateSemanticHandoff`: semantic workflow only. It matches workspace, original owner/SHA, mirror, token, refreshed revision, files and deletions; it permits candidate replacement only from the original candidate or an identical prepared child SHA. Completed rows replay their single stored result.
- `captureSemanticHandoff`: still called by all eleven mechanical workflows. It now returns the original job ID plus the persisted handoff token. Parent workflows retain their existing completion steps; a handed-off child never marks the row complete.
- Semantic no-op paths: both enqueue `workspaceHydrate` with `${jobId}:hydrate` before return. Standalone semantic commands then complete themselves; children return to the parent owner. Migration export removed its duplicate child-no-op enqueue but retains cutover completion.
- `planMergeSandbox` / `createMergeSandbox`: sole production orchestration is semantic merge. Provider and deterministic ID are durably returned by `plan-merge-sandbox`; allocation consumes that locator and never rediscovers a provider. Resolve/destroy use the same locator.
- `connectorMirrorContentSchema`: now domain-collocated and imported by admission, connector workflow, and semantic validation. Connector and semantic workflows no longer import each other in both directions.
- Dockerode declarations: local ambient declaration removed; pinned published types added to backend development dependencies. The structural options object retains the runtime connection deadline without extending third-party declarations.

## Standards and smell audit

- Documented checks covered explicit typed durable steps, one job/result owner, immutable command identity, canonical hydrate-before-completion, current-tip Git ownership, broker-only credentials, provider replay, compact completed-result projection, short SQL, transaction reuse, RLS, migration generation, backend logging and public-seam/native proof. No breach retained.
- Fowler baseline considered in full: Mysterious Name, Duplicated Code, Feature Envy, Data Clumps, Primitive Obsession, Repeated Switches, Shotgun Surgery, Divergent Change, Speculative Generality, Message Chains, Middle Man and Refused Bequest. One repeated handoff type shape was retained as a labelled judgement call. Explicit per-kind workflow repetition remains suppressed because ADR-033 requires visible workflow steps rather than a second runner.
- Prior review findings: missing no-op hydrate, nondurable provider choice and mirror/semantic workflow cycle are fixed. The earlier unbounded history fold is replaced by a compact state row and owner backfill.

## Evidence and exclusions

- Inspected recorded passing evidence for 25 bounded-path checks, fresh/upgrade migration installation, 22 ownership/provider checks, 141 acknowledged backend diagnostics, 230 acknowledged UI diagnostics after removing the resolved Dockerode allowance, scoped proof policy/Biome/whitespace, and predecessor CI. No heavyweight command was rerun.
- Explicitly excluded from omission findings: post-admission and repeated races, cancellation/abandoned-resource cleanup, worker-loss/replica recovery, Railway/sbx support, post-hydrate planning/caps, pause/protection resume, provider/alternate-writer migration, credential cleanup, generic/legacy deletion and terminal Gate 3 acceptance.
