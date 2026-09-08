# Spec coverage — Gate 3 owner/provider checkpoint

## Review identity

- Fixed base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`
- Pinned target: `9f719b0a5402930d2221358582b1ccd589e74adc`
- Commands: `git diff BASE...PIN`; `git log BASE..PIN`; all source reads pinned with `git show PIN:path`.
- Commit range enumerated: 12 commits, `e7c18bd8` through `9f719b0a`.
- Read-only review; no repository edits or test execution.

## Spec sources

- `docs/plans/workspace-chat-recovery.md`: foundation ownership at lines 47-58; OpenWorkflow/native Git boundaries at 89-104 and 264-279; Gate 3 requirements/exit/adversarial scope at 642-659.
- Locked ticket `.ai/scratchpad/git-backed-projects/issues/10-ingest-to-git-write-protocol.md`: one commit/no-op at 47-48 and 68-78; semantic non-FF at 54 and 80-82; job kinds/loop guards at 94-110; push uncertainty/hydration at 112-132.
- `.ai/memory/decisions/ADR-033-native-durable-write-workflows.md`: immutable artifacts 11-14; bounded path state 15; provider lifecycle 16; parent-owned child handoff 17; completion/hydration 18-21; explicit recovery override 23.
- Gate status and prior `checkpoint-6b5122c5-spec{,-coverage}.md` reviewed to distinguish corrections from declared remaining work.

## Changed surfaces and callers traced

- Schema/migration/backfill: both generated migrations, `db/schema/workspaces.ts`, `db/backfill-knowledge-path-state.ts`, `db/migrate.ts`, application-role grants.
- Path result flow: `persistWriteJobKnowledgePaths`, all three completion helpers, `projectCompletedKnowledgePaths`, `getCompletedKnowledgePaths`; extraction snapshot caller in `models/workspace-export.ts`; export/extract producers; bounded/backfill tests.
- Handoff ownership: `attemptWorkspaceCommit` → `captureSemanticHandoff` → `persistSemanticHandoff`; `validateSemanticHandoff`; semantic workflow start/prepared/no-op/push/hydrate paths; parent completion.
- All mechanical handoff callers: bootstrap, Files edit, claims upgrade, import cleanup, ops map, link/unlink, migration export, extraction, rename, valid-from, connector mirror. Export's distinct no-op cutover and mirror's source/managed-path binding were checked.
- Provider flow: detect/discover, plan locator, create/resume, structured resolution, destroy; Docker direct types/dependency changes and replay proof.
- Public admission/type surfaces: `write-job-intent.ts`, `enqueue-workspace-write-commit.ts`, connector content schema extraction, workflow schemas.

## Adversarial conclusions

- **Fixed:** no `${jobId}:semantic` result row; child is exact-delta and parent-owned; standalone semantic jobs remain typed independently.
- **Fixed:** both initial and resolved semantic no-ops durably enqueue canonical hydrate before terminal result.
- **Fixed:** provider/locator is a separately durable pre-allocation step; replay cannot rediscover a different provider after allocation starts.
- **Fixed:** runtime path reads do not traverse job history; relink/generation/connection/default-branch mismatch returns no assignments; completion is serialized and repeated terminal calls cannot reproject.
- **Finding:** initial upgrade reconstruction still orders historical rows by mutable pre-upgrade `updated_at`, so a historical completion replay can win incorrectly.
- **No new scope-creep finding:** the dedicated RLS projection is permitted operational projection state, while Git remains content authority.

## Explicitly open, not reported as regressions

Post-admission and repeated semantic races; cancellation/abandoned resources; worker-loss/replica and Railway/sbx completion; planner/caps and full pause/resume; alternate writer/credential migration and legacy deletion; Gates 4-6.

## Evidence disposition

Reviewed the pinned status assertions for 25 bounded-path checks, 22 semantic owner/provider checks, migration upgrade/fresh-install checks, full backend diagnostics with 141 acknowledged findings, and Docker/UI type corrections. These are supplied evidence, not independently rerun by this read-only review.
