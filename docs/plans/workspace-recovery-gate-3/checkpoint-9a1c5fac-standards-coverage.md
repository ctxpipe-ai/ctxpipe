# Gate 3 G3-A/B milestone — Standards coverage

## Identity and method

- Repository: `/private/tmp/ctxpipe-recovery-01a07aba`
- Fixed Gate 3 base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`; reviewed increment: `ec6d5340c4db91c4e888540deedddaa891ad9f58..9a1c5fac4fd6d8e2298a5fc25d8873239b22bcbf` (two commits, 67 paths, +5,297/-885; 32 paths excluding historical proof logs).
- Exact pin and fixed merge base verified. Read-only inspection used pinned `git diff`, `git log`, `git grep`, and `git show`. Historical logs, the moving worktree, and test execution were excluded.

## Sources and scope

- Root/backend/codesearch `AGENTS.md`; code-review and TDD/mocking rules; source-connectors guidance; ADR-027/028/033.
- Focused G3-A/B correction review per the approved milestone process. G3-C–G and tool-enforced matters were excluded. The nine earlier Fowler judgments were retained without re-investigation.

## Changed interfaces and caller coverage

- **Connector ownership:** traced `prepareConnectorSync`, `findConnectorSyncOwner`, `activateConnectorSync`, both terminal status branches, Linear/Notion/Confluence readers/finalizers, explicit upgrade backfill, and config/content enqueue catch recovery. Every authoritative OpenWorkflow query now filters default namespace, expected provider/purpose workflow name, and null version. Four native config/content × version/namespace cases exercise admission rejection, stored-pointer rejection, activation rejection, and terminal non-projection. Existing provider config/finalization suites cover accepted owners. The previous ec6 blocker is closed.
- **Repository ownership:** traced preparation, native lookup, activation, `repositoryIngestionWriteCondition`, read-side owner projection, and metadata-only upgrade. Direct and fallback IDs now retain the same name/namespace/version fence. Three native version/namespace/name cases verify no readiness/status mutation and no foreign pointer adoption; nine reported repository cases cover ordinary ownership.
- **Lifecycle retirement:** searched the pin for removed Linear/Notion claim/retry functions and Confluence initial-sync/upsert helpers; no callers remain. Route/webhook tests were updated to use native admission instead of direct state claims.
- **Semantic handoff:** traced mechanical broker race → Git delta extraction → locked `persistSemanticHandoff` → durable step output → semantic child validation/publication. Existing handoffs compare immutable owner, candidate, file and deletion delta and return the stored revision; caller no longer substitutes the newly refreshed revision. Process tests inject an actual lost PostgreSQL COMMIT reply, kill the worker at both handoff/child boundaries, advance Git again, and verify one publication and stable job result. Nine reported process-loss/ACK cases cover the path.
- **Legacy paused SHA:** traced `listPausedWriteJobs`/`enqueueInputFromPausedJob` through admission. Adoption is restricted to ownerless/uncommitted paused or queued rows; the immutable job generation, repository URL, desired SHA and default branch still gate persistence. Native test advances the tip before and after admission and verifies semantic convergence without losing either human change.
- **Ancillary:** inspected fixture namespace selection, ACK fault helper, ADR/status/remaining ledger, and affected tests. Reported connector 94/repository 9, process-loss 9, pause/write 24, and backend type results were not rerun.

## Counts

- Documented-standard violations: **0**
- Blocking findings: **0**
- Fowler heuristic judgments: **9 retained backlog**
