# Standards coverage — `667ad146d4533f82488e2aac7d232ad9b416e52a`

## Identity and method

- Fixed base `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`; pinned target `667ad146d4533f82488e2aac7d232ad9b416e52a`; 27 commits and 1,612 cumulative changed paths.
- Reviewed only pinned `git diff`, `git log`, `git show TARGET:path`, and `git grep TARGET`; ignored the moving worktree. No tests, native workflows, branches, or product files were changed.
- The `ae2c1bed...667ad146` increment has 54 paths: 17 production paths, seven test paths (including deletions), seven ADR/plan/review paths, 22 evidence paths, and one CI path; 2,647 insertions and 2,261 deletions.
- Applied root/backend `AGENTS.md`, source-connectors with the accepted ADR-033 override, ADR-027/028/033, TDD/mocking, the accepted status/audit, and all twelve supplied Fowler heuristics. Tool-enforced formatting was excluded.

## Increment and interface/caller ledger

- `captureRepositoryExtractionTarget` is new and has one production caller, `repositoryIngestion`. It selects the repository's own workspace or the organization's first workspace, resolves a credential-free revision, and for a linked repository verifies the existing Git declaration before returning the destination. Model helpers own their short DB scopes; the subsequent pack read is outside them.
- `workspaceExtractionSchema` remains the runtime boundary used by write-job intent and `workspaceExtractIngest`; the producer now also parses through it before calling the child. Its transform collapses duplicate object keys in encounter order with `mergeRetrievalObjectPayloads`, while the input, persisted job payload, and completed replay comparison retain repository URL/id and source SHA.
- `mergeRetrievalObjectPayloads` moved to a pure domain module. Its callers are extraction canonicalization and the retained retrieval-object write service; that service re-exports it for existing tests. The old DB writer has no non-test caller at this pin.
- `planCapturedExtraction` is a new pure adapter called only by `workspaceExtractIngest`. It maps captured objects/claims to `planKnowledgeProjection`, resolves existing serving IDs and completed path assignments only when their files still exist, and maps the source repository to an existing root `AGENTS.md` or linked declaration.
- `planKnowledgeProjection` gained optional `referencePaths`; callers remain migration-export production/tests plus the new adapter. The map seeds both object ownership and destination paths, so claims may target files already owned by Git without synthesizing projection-table content.
- `workspaceExtractIngest` now reads all non-mirror Markdown so root `AGENTS.md` and repository declarations participate in reference resolution. It filters writes back to `knowledge/`, records path identity, and retains native acquisition, no-op recheck, stage/validate/commit, broker push/semantic handoff, hydrate, and completion ownership.
- `repositoryIngestion` still receives work through `repository-ingestion-orchestrator`; Linear/Notion content/entity workflows invoke the enqueue facade. It captures the destination before source work, runs the existing index child and extraction/model steps, aggregates durable per-root outputs, and calls `workspaceExtractIngest` with stable job/child identities. Publication completes before repository readiness and follow-up-tip admission.
- Deleted production surfaces are `extractionSubgraph`, its alternate graph, `deduplicateAndStore`, `embed`, `project`, and `retractStaleEvidence`; `graphs/index.ts` no longer exports the retired graph. Pinned symbol searches found no production callers. `runExtractKindForRoot` and `runIdentifyPhaseForRoot` remain the producer's extraction functions; the combined `runExtractForRoot` has no caller.
- The Confluence PATCH comparison now uses the shared canonicalizer and normalizes omitted page IDs to null. The route's new `empty-spaces` native case exercises null versus empty selection and owner reuse.
- CI backend timeout moved from 20 to 30 minutes because the serialized native suite contains real waits. This is test infrastructure and yielded no standards finding.

## Proof disposition

- Inspected, but did not rerun, committed claims for duplicate extraction merge, Confluence empty/null canonicalization, native historical-capture restart, repository reference rendering, types at 138 existing diagnostics, proof policy, and scoped Biome.
- `repository-extraction-native.contract.test.ts` uses a real OpenWorkflow/PostgreSQL/Git fixture. Historical native step results cross a stopped-worker boundary; the resumed production producer and typed writer publish one commit and a literal relative `IMPLEMENTED_IN` link to `AGENTS.md`.
- The test is explicitly a captured-history recovery seam rather than the declared-open live model journey. No changed test introduces an owned-module `vi.mock`.

## Fowler baseline disposition

- Closed: Confluence **Duplicated Code** and extraction **Feature Envy** from the prior review.
- New: one **Speculative Generality** group covering production-unreachable persistence APIs and obsolete ingestion-state/helper surfaces left after pipeline deletion.
- Remaining: two **Mysterious Name** judgments (`sourceId`; dual-purpose `contentSyncWorkflowRunId`), one connector **Repeated Switches**, and four acknowledged **Duplicated Code** shapes (connector admission, GitHub credential issuance, conversation preparation/publication, typed workspace admission).
- Suppressed: similarity among typed native workflows because ADR-033 requires each workflow to expose its own lifecycle; root step-name normalization because OpenWorkflow deterministically suffixes repeated names in stable registration order.
- No actionable Feature Envy, Data Clumps, Primitive Obsession, Shotgun Surgery, Divergent Change, Message Chains, Middle Man, or Refused Bequest found.

## Counts

- Documented-standard violations: **0**
- Fowler heuristic smells: **8**
- Implemented-scope blockers: **0**
