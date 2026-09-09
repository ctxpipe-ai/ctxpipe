# Gate 3 cumulative closure — Standards review

Pinned range: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...d3ba7e591ecb557ca1e5c3da96ec9e99d0dd1f67` (40 commits). CI is pending, so this review does not declare Gate 3 closed.

## Documented-standard violation

1. **[P1, blocker] Repository-subject extraction can rewrite owner instructions during semantic reconciliation.** `assertExtractionSource` returns immediately for the workspace repository after checking only that no linked declaration was supplied (`apps/backend/src/domain/workspaces/extraction-source.ts:55-68`). A raced extraction can then send an `AGENTS.md` conflict to the model, whose structured result contains unrestricted full content (`apps/backend/src/domain/workspaces/semantic-merge.ts:125-183`); the semantic workflow stages it and the broker repeats the same early-return check before issuing credentials/pushing (`apps/backend/src/openworkflow/workflows/workspace-semantic-merge.ts:216-327`; `apps/backend/src/domain/workspaces/write-broker.ts:114-162`). This violates ADR-033:46: repository-subject claims use the same owner-preserving merge, and claims-only edits preserve instruction-body bytes. Capture the root authority and enforce the linked declaration’s candidate invariant for `AGENTS.md`: only claims may differ; path, body, and non-claims metadata must remain unchanged. Add native semantic-race negatives for body, metadata, and deletion.

## Verified cumulative standards

The ownership inventory has no alternate active default writer: normal and unborn pushes are broker-only; conversation and GitHub API writes remain session/config-branch scoped. All twelve concern kinds have explicit typed workflows, durable packs/results, binding checks, bounded race handling, hydration tails, and native restart/ACK-loss proof. SQL ownership operations remain short and exclude Git/provider/model I/O.

The F deletion is legitimate: removed allocation/clone/claim symbols have no production callers. The retained handle adapter serves conversation Files, while the registry serves conversation and pre-upgrade destruction. Published Workspace Files status no longer consults job state. Canonical Notion/Confluence content keys match provider selection semantics. Replacing obsolete allocator mocks with native Git/PostgreSQL/OpenWorkflow/HTTP contracts follows TDD/mocking guidance.

## Fowler heuristics (non-blocking)

Retained backlog: **Mysterious Name (2), Repeated Switches (1), Duplicated Code (6)**. No new heuristic.

**Counts:** 1 documented violation / 1 blocker; 9 cumulative non-blocking heuristics.
