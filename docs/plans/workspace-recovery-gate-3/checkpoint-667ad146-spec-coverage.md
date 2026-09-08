# Gate 3 repository-producer Spec coverage ledger

## Review identity

- Repository: `/private/tmp/ctxpipe-recovery-01a07aba`
- Base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`
- Target: `667ad146d4533f82488e2aac7d232ad9b416e52a`
- Read `git diff BASE...TARGET`, `git log BASE..TARGET`, and `git show TARGET:path`. The moving worktree was not used.
- Read-only review: no repository changes, native workflows, test processes, network actions, or delegation.

## Requirements applied

- `docs/plans/workspace-chat-recovery.md:642-659`: typed OpenWorkflow ownership, explicit durable steps, deterministic transforms, one commit/result, and full writer/caller audit.
- `.ai/scratchpad/git-backed-projects/issues/10-ingest-to-git-write-protocol.md:11-14,47-48,68-77,96-110`: ingest content reaches the canonical workspace repository in one job/at most one commit; projections update through hydrate.
- `.ai/scratchpad/git-backed-projects/issues/02-hydration-contract.md:35-54`: path-derived serving identity, permanent relative links/claims, repository declarations, workspace-local projections, and derived-store ownership.
- `.ai/memory/decisions/ADR-033-native-durable-write-workflows.md:11-19,22-26,30,37-39`: immutable extraction input, durable native child, duplicate merge, reference adaptation, and explicit remaining producer work.
- `docs/plans/workspace-recovery-gate-3/status.md:487-497` and `write-path-audit.md:38-40`: implemented claims and declared remaining scope.

## Increment coverage (`ae2c1bed...667ad146`)

### Immutable batch and prior finding

- `domain/workspaces/extraction.ts`: followed pre-transform validation and encounter-order duplicate collapse. Verified last kind plus legacy stub-aware payload semantics.
- `domain/workspaces/extraction-payload.ts`, `retrieval/services/retrievalObjectWrite.ts`: the old pure merge is extracted and shared; retained DB upsert behavior still imports/re-exports it.
- `domain/workspaces/write-extract-native.contract.test.ts`: duplicate rich observation followed by consumer stub now retains complementary fields; existing collision/replay/no-op cases remain.

### Producer target and lifecycle

- `domain/workspaces/capture-repository-extraction.ts`: destination is captured before extraction; own workspace is preferred, otherwise the recorded first workspace must contain a matching Git declaration. Revision capture uses repository-scoped read resolution.
- `openworkflow/workflows/repository-ingestion.ts`: traced repository read → destination capture → source ref/index → roots → per-root kind/identify captures → canonical batch parse → stable `wjob_${run.id}_extract` native child → repository success → tip follow-up. The child is awaited before success.
- OpenWorkflow 0.8 runtime: verified `step.run` returns the persisted `savedAttempt.output` after `completeStepAttempt` on first execution and cache replay (`node_modules/.pnpm/openworkflow@0.8.0_postgres@3.4.8/node_modules/openworkflow/dist/worker/execution.js:410-445`). Its PostgreSQL backend stores `pg.json(params.output)` and returns the JSONB record (`dist/postgres/backend.js:669-693`). Thus optional `undefined` properties emitted inside kind/identify callbacks are removed before parent aggregation and batch parsing; the initially reported P1 had no native execution path and is withdrawn.
- `graphs/codeIngestionGraph/runExtractRoot.ts`: direct pure extraction phases preserve kind-before-identify and concatenate branch outputs in deterministic input order.
- `openworkflow/workflows/repository-extraction-native.contract.test.ts`: reviewed historical-step replay, replacement worker, one Git commit, and repository reference assertion. It is intentionally not a live extractor proof and contains no payload object.

### Git projection and reference handling

- `domain/workspaces/plan-extraction.ts`: checked only-existing-path filtering for completed identity; serving-ID mapping for acquired Markdown; own-repository → `AGENTS.md`; external repository → parsed matching declaration; claim adaptation into shared projection.
- `domain/workspaces/migration-export.ts`: `referencePaths` seed both workspace ownership and path maps, so existing endpoints participate in claims without becoming newly rendered objects.
- `openworkflow/workflows/workspace-extract-ingest.ts`: now reads all non-connector Markdown needed for root/declaration references; output remains filtered to `knowledge/**`. Traced no-op refresh, stage/validate/commit, broker/semantic child, publication, hydrate, and result ownership at the changed adapter boundary.

### Retired persistent pipeline and callers

- Confirmed deletion of `extractionSubgraph`, alternate `graph.ts`, `deduplicateAndStore`, `project`, `embed`, and ingestion `retractStaleEvidence` nodes plus their owned tests.
- Production searches found no remaining repository-ingestion call to those deleted DB/graph/embed paths. `graphs/index.ts` no longer exports the alternate writer. Retained retrieval upsert/retraction helpers still have non-ingestion consumers such as repository deletion; they were not incorrectly removed.
- Reviewed all current repository-ingestion admissions: explicit repository route, GitHub webhook, connector routes/children, and tip follow-up still converge on the orchestrator/producer. Native producer admission/terminal recovery remains explicitly open.
- `models/atlassian-connector.ts` also adopts the shared Confluence canonical selection; affected route fixture updates and CI inventory changes were checked for scope consistency.

## Adversarial cases considered

- Duplicate observations: fixed.
- Payloads containing absent optional values: audited through first-execution and replay runtime semantics; the PostgreSQL JSONB round trip removes them before aggregation. No defect.
- Changed captured payload/job replay, worker restart, one/no-op commit, path collisions, claims to repository root/declaration, completed import identity, and serving-ID references: traced.
- Multiple destination endpoints, source declaration/rebind races, deleted-source retraction, output/step bounds, legacy producer recovery, and terminal child reconciliation: recorded as declared OPEN scope and not counted as new defects.

## Result

- **0 P1, 0 P2, 0 P3.**
- Previous duplicate extraction finding: verified closed.
- Initial undefined-payload finding: withdrawn after verifying native persisted-output semantics.
- Checkpoint remains intermediate; no Gate 3 acceptance claim.
