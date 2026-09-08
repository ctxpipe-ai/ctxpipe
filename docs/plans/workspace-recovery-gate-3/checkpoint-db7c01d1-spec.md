# Spec review — Gate 3 checkpoint db7c01d1

Pinned range: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...db7c01d13a5d763340b3d49aad50881b88aa6ac5` (correction focus `529b0bfd...db7c01d1`).

## Findings

**P1 — Recovered workspace admission does not persist the recovered owner.** Gate 3 exits only when every change has “one durable result” (`docs/plans/workspace-chat-recovery.md:653-654`), and ADR-033 requires status to reconcile a terminal owning OpenWorkflow run (`.ai/memory/decisions/ADR-033-native-durable-write-workflows.md:18`). After a lost returned row, `reconcileWriteJobAdmission` finds an accepted run but returns only a boolean; it leaves `payload.workflowRunId` null (`apps/backend/src/models/workspace-write-jobs.ts:719-754`). `enqueueWriteJob` nevertheless returns `{started:true}` (`apps/backend/src/openworkflow/enqueue-workspace-write-commit.ts:384-390`). If that run is canceled before `claim-command`, terminal reconciliation cannot match it because it only joins `owner.id` to the missing payload value (`workspace-write-jobs.ts:569-598`); the job remains queued/paused indefinitely. Persist the matched run ID under the row lock before acknowledging recovery. The success test starts the worker before checking completion, so it does not exercise this trigger.

**P2 — A degraded refresh retains A’s files but reports A unavailable.** Ticket 11 says, “Serve whatever projection and index we have” (`.ai/scratchpad/git-backed-projects/issues/11-project-revision-and-freshness.md:104`). Production activation clears `indexReady` for B (`apps/backend/src/models/repository-ingestion-requests.ts:153-170`); when B’s Zoekt build fails, `markRepositoryIndexingIssues` preserves A’s hash but never restores readiness (`apps/backend/src/models/repositories.ts:471-496`). Thus ordinary reads correctly select A while API/conversation state says `indexReady:false`. The new test misses this because it invokes `repositoryIndex` directly after manually marking A ready, bypassing activation (`repository-index-source-native.contract.test.ts:130-202`). Preserve readiness when a prior complete hash exists, and add an orchestrator-level degraded-refresh case.

The previous failed-Zoekt publication finding is otherwise closed, graph tools honor captured source scope, and both admission-loss modes preserve one commit on successful retry. Declared Gate 3 remainder is excluded.

**Total: 2 findings (1 P1, 1 P2).**
