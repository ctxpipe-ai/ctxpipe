# Standards review — `8c1ca3a69717e27be87dcd9f436d8a1f2ca7386c`

**Pinned range:** `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...8c1ca3a69717e27be87dcd9f436d8a1f2ca7386c`
**Result:** 2 documented violations; 2 heuristic smells; 1 implemented-scope blocker.

## Documented-standard violations

1. **Terminal reconciliation misses an owned job during resume.** `claimPausedWriteJob` changes every paused row to `queued` (`workspace-write-jobs.ts:213-226`), including rows with a native `workflowRunId`. Yet `reconcileWorkspaceWriteJob` projects a failed/canceled owner only when the row is `running` or `paused` (`:562-589`). Cancellation after the periodic claim and before the owner’s next `resume-command` leaves the public row queued forever. This violates ADR-033:18’s requirement to reconcile the matching terminal owner and :23’s one-owner pause/resume rule. Include owned `queued` rows in terminal reconciliation, or avoid changing an owned pause to queued; add the interleaving proof rather than only canceling a stable paused row (`write-pause-native.contract.test.ts:597-665`).

2. **One-use workflow dispatch remains module-global.** `snapshotWriteWorkflows` is declared at `enqueue-workspace-write-commit.ts:54-65` and read only at `:175`. Root `AGENTS.md` says not to extract one-off config/values to module scope unless reused. Keep the map local to admission (or replace it with the typed dispatch refactor below).

## Fowler heuristic smells (judgment calls)

1. **Duplicated Code.** Five admission branches repeat parse → `persistBoundWriteJob` → set `bound` → enqueue → return (`enqueue-workspace-write-commit.ts:218-335`). A typed command-builder/dispatcher can share this shape without reintroducing the deleted lifecycle runner.

2. **Data Clumps (remaining).** Connector finalizers still repeat `{ connectionId, repositoryId, branch, workflowStatus }` in three model APIs and callers (`linear-connector.ts:1253-1258`; Notion/Confluence equivalents). Use one captured-finalization identity type while retaining provider-specific persistence.

The prior Linear transaction breach is fixed: its caller is direct and the model asserts no ambient org transaction. Export follow-ups use binding-fenced capped reservations and durable typed admission; cleanup fences cutover; Files waits for admission; the generic runner has no remaining references. Declared conversation/registry cleanup was excluded.
