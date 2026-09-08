# Gate 3 admission/recovery checkpoint — Standards review

Pinned range: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...db7c01d13a5d763340b3d49aad50881b88aa6ac5`

## Documented-standard violation (1)

**[P1] A failed refresh does not restore the prior revision’s readiness.** Production runs `markRepositoryIndexingRunning` first, which sets `indexReady: false` (`apps/backend/src/models/repositories.ts:415-437`; called at `openworkflow/workflows/repository-ingestion.ts:128-140`). When Zoekt later fails, `markRepositoryIndexingIssues` preserves `lastIngestedHash` but never restores `indexReady` (`repositories.ts:471-496`; selected at `repository-ingestion.ts:579-595`). A repository with a complete older revision therefore ends `complete_with_issues` yet unready. That violates ADR-033:34: a search failure must preserve the prior hash, timestamp **and readiness**. The replacement native test misses the production transition: it calls `repositoryIndex` and `markRepositoryIndexingIssues` directly (`repository-index-source-native.contract.test.ts:130-187`), so its initial `indexReady: true` is never cleared. This also violates TDD `SKILL.md`/`mocking.md`: proof must exercise the public/owned seam rather than reconstruct only selected internals. Derive readiness from the retained published hash (or restore it explicitly), and run the failure through `repositoryIngestion` or include the real running transition.

The prior graph blocker is closed. `checkoutKey` no longer defaults to `default`, captured source authority removes any supplied body key (`tools/codegraphTools.ts:15-122`; `tools/codesearchGraph.ts:64-75`), and the native test invokes the public graph tool after a newer publication. PostgreSQL reply-loss recovery now discovers the accepted owner, wakes execution and preserves one command/commit; request rejection remains retryable.

## Fowler heuristic judgments (9; non-blocking)

All nine cumulative judgments remain: **Mysterious Name (2)** (`sourceId`/`evidenceKey`; `contentSyncWorkflowRunId`), **Repeated Switches (1)** in connector lifecycle dispatch, and **Duplicated Code (6)** across typed-write admission, connector admission, GitHub credential issuance, conversation preparation/publication, captured-source JWT assembly, and duplicated published-checkout SQL. This increment does not refactor those shapes.

**Blockers: 1.**
