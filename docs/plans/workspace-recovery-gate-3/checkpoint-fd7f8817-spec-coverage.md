# Coverage ledger — Spec review of `fd7f8817`

## Review boundary

- Repository: `/private/tmp/ctxpipe-recovery-01a07aba`
- Fixed base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`
- Pinned target: `fd7f8817d3417a9cb5c4ce3e5a46fb3b1a782fa1`
- Cumulative comparison: `git diff bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...fd7f8817d3417a9cb5c4ce3e5a46fb3b1a782fa1`
- Increment examined in detail: `db7c01d13a5d763340b3d49aad50881b88aa6ac5...fd7f8817d3417a9cb5c4ce3e5a46fb3b1a782fa1`
- Increment commit: `fd7f8817 Gate 3: reconcile recovered owners and retain source readiness`
- All source reads used `git show`/`git grep` at the pinned target. No product files were changed and no native or backend suite was run.

## Spec sources

- `docs/plans/workspace-chat-recovery.md:642-659` — typed native workflows, durable ownership/retry, Gate 3 exit criteria.
- `.ai/scratchpad/git-backed-projects/issues/10-ingest-to-git-write-protocol.md:9-33,43-48,66-82,94-110` — Git canonical state, no-op/one-commit semantics, independent typed jobs.
- `.ai/memory/decisions/ADR-033-native-durable-write-workflows.md:18,33-34,42-53` — terminal native-owner projection, source refresh readiness, repository-subject claims, evidence normalization, ingestion admission.
- `docs/plans/workspace-recovery-gate-3/status.md` and prior pinned db7 Spec report — checkpoint claims, evidence, and explicitly open acceptance inventory.

## Changed production surface and caller tracing

### Workspace write owner recovery

- `models/workspace-write-jobs.ts`
  - Traced new `nativeWriteJobOwnerId` correlation across org/workspace/job, stored owner ID, default namespace/idempotency key, and immutable revision.
  - Traced `reconcileWorkspaceWriteJob` terminal failed/canceled projection and recovered owner persistence.
  - Traced `reconcileWriteJobAdmission` row lock, recovered ID persistence, and rejection of genuinely ownerless queued/paused rows.
- `openworkflow/enqueue-workspace-write-commit.ts`
  - Traced pre-admission reconciliation, immutable command reuse, native idempotency, enqueue error reconciliation, and retry return behavior.
- `openworkflow/workspace-admission-ack-native.contract.test.ts`
  - Inspected returned-row and disconnect loss for both commit and cancel-before-worker outcomes. The cancellation case has one native owner, failed durable job, and unchanged remote.
- Result: prior db7 cancellation blocker closed. No second job/result owner introduced.

### Repository source readiness

- `models/repository-ingestion-requests.ts`
  - Traced activation for pending and recovered running/sleeping owners. `indexReady` now derives from the previously published hash.
- `models/repositories.ts`
  - Traced queued/running/ready/complete-with-issues transitions. Running and issue paths preserve readiness and do not overwrite the prior published hash/timestamp.
- `models/repository-ingestion-owners.ts`
  - Traced list/detail read projection for pending/running/completed/failed/canceled owners. Terminal failure overlays status/error/steps while preserving stored `indexReady` and `lastIngestedHash`.
- `openworkflow/workflows/repository-index-source-native.contract.test.ts`
  - Inspected the full owner→producer→index path after A is published and B fails Zoekt. It proves queued readiness and final issue state continue serving A through Files, graph, and lexical readers. `markRepositoryIndexingRunning` is exercised by the production workflow.
- Result: prior db7 readiness blocker closed for queued, running, issue, and uncaught terminal failure projections.

### Repository-subject claim publication

- `openworkflow/workflows/workspace-extract-ingest.ts`
  - Traced acquired Markdown selection, deterministic planning, changed-file filtering, stage/validation, and one-commit/no-op paths.
- `domain/workspaces/plan-extraction.ts`
  - Traced repository ID→root `AGENTS.md` reference assignment and claims-only existing-subject projection.
- `domain/workspaces/migration-export.ts`
  - Traced `planKnowledgeProjection`, claims merge identity, claims-only rendering, and `mergeExistingImportedMarkdown` body reconstruction. Finding 1 arises here.
- `domain/workspaces/knowledge-metadata.ts`
  - Confirmed the lower-level YAML mutation helper preserves the original body bytes when given the original file, providing a direct correction path.
- `domain/workspaces/write-extract-native.contract.test.ts`
  - Confirmed custom front matter and visible prose are retained for ordinary and `AGENTS.md` subjects, but the assertion does not cover exact instruction bytes.

### Dot-segment evidence

- `domain/workspaces/retract-extraction.ts`
  - Traced repository URL comparison, percent decoding, POSIX normalization, traversal rejection, partial/full scope matching, expiry, and reassertion.
- `domain/workspaces/plan-extraction.ts`
  - Traced normalized evidence into claim identity and canonical generated source URLs.
- `domain/workspaces/write-extraction-retraction-native.contract.test.ts`
  - Confirmed internal `./src/../src/...` convergence coverage, encoded fragments, relative evidence, and URL normalization. Root-equivalent `#./`/`#src/..` is absent; Finding 2 remains.

## Declared open scope

The checkpoint is not treated as Gate 3 acceptance. The remaining inventory recorded in the pinned status/write-path audit (live producer and terminal recovery edges, true empty bootstrap, config ordering, crash/resource proofs, cleanup and residual migration/deletion work) was kept separate and is not reported as a new defect here.

## Finding count

- P1: 1
- P2: 1
- Total actionable Spec findings: 2
- Prior db7 findings verified closed: 2 of 2
