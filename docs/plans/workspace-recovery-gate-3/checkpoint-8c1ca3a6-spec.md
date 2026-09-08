# Gate 3 runner-retirement checkpoint — Spec review

**Pinned range:** `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...8c1ca3a69717e27be87dcd9f436d8a1f2ca7386c`
**Decision:** changes required for implemented scope — 2 P1, 1 P2.

## Findings

1. **[P1] Export maintenance is admitted before successful hydrate.** `workspace-migration-export.ts:283-293` only enqueues `workspaceHydrate`; it does not await its result. The parent immediately reserves and admits bootstrap/cleanup at `:294-369`, while cleanup's only prerequisite is completed export metadata (`workspace-import-key-cleanup.ts:88-101`). With the production worker's concurrency, cleanup can remove migration keys and advance the canonical tip while export hydration is pending or failing. Ticket 10 line 60 requires: **“enqueue after a successful hydrate if work remains.”** Keep durable reservation after export completion, but admit these commands from successful hydration (or await a durable hydrate child result) so the ordering is enforced rather than queue-order-dependent.

2. **[P1] Files bypasses paused native admission for unavailable writes.** `workspace-files-routes.ts:451-452` still calls `writeJobQueueHttpDecision`, whose `write-jobs.ts:51-59` rejects both `read_only` and `unknown` before `enqueueWorkspaceWriteCommit`. Thus a Files save receives 400/409 and never gets the typed owner that the new admission path supports. ADR-033 line 23 says: **“Admission binds and queues every typed kind even while write access is unavailable.”** Route valid GitHub requests through admission and return 202 once the paused workflow is durably queued.

3. **[P2] Periodic resume can strand a canceled paused job as `queued`.** `workspace-tip-check.ts:87-106` lists and claims paused rows without reconciling their native owners; `claimPausedWriteJob` changes the row to `queued` (`workspace-write-jobs.ts:213-225`). If its owning run was already canceled, re-enqueue reuses the same idempotency key, while `reconcileWorkspaceWriteJob` only repairs `running`/`paused` (`:562-581`). The row can therefore remain queued behind a terminal owner indefinitely. This conflicts with ADR-033 line 18: **“Job status reconciles terminal owning OpenWorkflow state.”** Reconcile atomically before claiming, or make claim/reconciliation cover this queued-owner state.

The prior Linear transaction issue is fixed, binding fences and typed dispatch are intact, and the generic workflow/runner/agent/worktree executor is absent. Declared remaining Gate 3 work was excluded.
