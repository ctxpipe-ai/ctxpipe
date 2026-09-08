# Spec coverage — Gate 3 checkpoint db7c01d1

## Boundary and sources

- Fixed base `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`; pinned target `db7c01d13a5d763340b3d49aad50881b88aa6ac5`.
- Inspected cumulative diff/log and correction diff `529b0bfd08d1e73618285cc5867c4859062b2c14...db7c01d13a5d763340b3d49aad50881b88aa6ac5` using committed blobs only.
- Applied the Gate 3 recovery plan, tickets 02/09/10/11/18, ADR-033, and pinned status. No implementation changes or test execution.

## Prior finding: failed Zoekt publication

The published-checkout defect is closed:

- `repository-index.ts:305-325` still records Zoekt failure and permits SCIP/extraction to finish.
- `repository-ingestion.ts:579-595` now calls `markRepositoryIndexingIssues` rather than the former ready-with-issues writer.
- `repositories.ts:471-496` no longer changes `lastIngestedHash`, `lastIngestedAt`, or `indexReady` on that failure path.
- Ordinary backend/codesearch selectors therefore retain `rev:<A>` when B's Zoekt phase fails (`repositories.ts:54-59`; codesearch `domain/repositories/service.ts:76-81`). File, lexical, structural, and graph reads continue using A.
- `repository-index-source-native.contract.test.ts:130-202` verifies retained hash/files/Zoekt result. It does not pass through ingestion activation, which exposed finding P2: actual admission first writes `indexReady:false`.

## Graph captured-source calls

- `codegraphTools.ts:15-125` removes the legacy `checkoutKey:"default"` schema defaults. Ordinary calls now omit a checkout key and let the service choose the latest complete published checkout.
- `codesearchGraph.ts:28-84` reads the extraction AsyncLocal source, emits a repository/SHA JWT, forbids simultaneous workspace scope, and removes any model-supplied checkout key from the body when a captured source exists.
- Codesearch `routes/graph.ts:76-185` derives the authoritative key from the JWT and rejects a conflicting body key. The source test invokes `graphFindSymbolTool` while A is captured after B is published.
- Caller search found only `workspace-chat-tools.ts` and `codegraphTools.ts`; workspace chat passes explicit workspace authority, while ingestion tools inherit captured source authority. No path can use a model default to select `default` during extraction.

## Workspace admission acknowledgement

- Each typed path persists its immutable command before `runWorkflowWithWorkerWake`; `persistBoundWriteJob` validates kind, binding, revision, files/deletes, mirror/extraction, rename base and display name (`workspace-write-jobs.ts:601-716`).
- On an enqueue exception, `reconcileWriteJobAdmission` locks the job and accepts only a native run matching org/workspace/job plus either saved owner ID or default-namespace idempotency key and exact revision (`:719-754`). If no run exists it marks an unowned queued/paused job failed, so retry can reopen it.
- `enqueue-workspace-write-commit.ts:384-400` wakes the worker and returns success only when reconciliation sees the accepted run; otherwise it returns failure.
- `workspace-admission-ack-native.contract.test.ts` covers both missing returned `DataRow` and a TCP disconnect after committed INSERT, then retries, runs the real file-edit workflow, verifies one native run, one remote commit, and completed status.
- `native-workflow-ack-loss.ts` parses PostgreSQL protocol frames and drops the reply only after `INSERT 0 1` plus idle `ReadyForQuery`, so the injected loss occurs after the native row commits.
- Finding P1 remains because the reconciler projects only a boolean. Before the workflow executes `claim-command`, `payload.workflowRunId` stays null; a canceled/failed pending owner cannot satisfy `reconcileWorkspaceWriteJob`'s owner-ID join.

## Repository ingestion acknowledgement

- `enqueue-repository-ingestion.ts:15-46` reserves intent, uses request ID as the native idempotency key, and after an exception resolves the concrete owner ID, schedules a worker wake, then calls `activateRepositoryIngestionRequest` with that ID.
- `repository-ingestion-requests.ts:81-172` verifies request identity, target binding, native workflow name/input, and persists `workflowRunId` before returning acknowledgement. This path does not share workspace finding P1.
- `repository-admission-ack-native.contract.test.ts` exercises committed-row response loss and confirms retry returns the same owner and queued state. The common wire fixture supplies the actual post-commit failure seam.

## Cumulative prior corrections retained

- Repository creation and Confluence config await retryable ingestion admission and reuse persisted entities.
- Source index artifacts remain repository/SHA scoped; request-fenced progress prevents stale owners overwriting current progress.
- Default-branch follow-up keeps null/default selection, while explicit branches remain explicit.
- Evidence identity normalizes repository URL, relative source and encoded hash fragments.
- Source extraction file, lexical, structural and graph tools use captured SHA authority.

## Declared open scope, not findings

The pinned status keeps the full live producer journey, true empty/unborn bootstrap, remaining configuration ordering, model/allocation crash proof, cumulative cleanup and later gates open. Those items were not counted as checkpoint regressions.
