# Gate 3 fd7 checkpoint — Standards coverage

## Identity and method

- Repository: `/private/tmp/ctxpipe-recovery-01a07aba`
- Fixed base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`
- Reviewed pin: `fd7f8817d3417a9cb5c4ce3e5a46fb3b1a782fa1`
- Exact pin and merge base were verified. The cumulative range has 33 commits and 1,917 changed paths. Increment `db7c01d13a5d763340b3d49aad50881b88aa6ac5..fd7f8817d3417a9cb5c4ce3e5a46fb3b1a782fa1` has 39 paths (+1,810/-54).
- Review used pinned `git diff`, `git log`, `git grep`, and `git show`. The moving worktree and native test processes were excluded.

## Sources applied

- Root/backend/codesearch `AGENTS.md`; code-review skill and the complete supplied Fowler baseline; TDD `SKILL.md` and `mocking.md`; source-connectors guidance.
- ADR-027/028 short transaction ownership; ADR-033 typed workflow ownership, immutable source, serving publication and replay; current Gate 3 status.
- Tool-enforced formatting/type concerns and declared unfinished Gate 3 acceptance inventory were excluded.

## Changed surfaces and caller trace

- **Published readiness:** traced `enqueueRepositoryIngestionWorkflow` through request activation, `repositoryIngestion` running projection, `repositoryIndex`, issue projection and `getRepositoryForOrg`/`fetchFiles`/`codeSearch`. Both activation and running/issue helpers now compute `indexReady` from `lastIngestedHash`. The native failure contract deletes the extraction destination, starts the orchestrator/producer/index implementations, makes the real Zoekt path fail, and observes the prior hash/files/search remaining ready. This closes the db7 Standards finding and replaces its partial internal proof.
- **Workspace owner recovery:** traced every typed branch in `enqueueWriteJob` to `persistBoundWriteJob`, `runWorkflowWithWorkerWake`, admission catch reconciliation, first workflow claim, and terminal `reconcileWorkspaceWriteJob`. The shared scalar lookup is atomic under the job lock and correctly captures the run ID after returned-row or connection loss. It omits workflow name/version even though enqueue selects one of twelve typed specs and OpenWorkflow's pinned backend scopes idempotency lookup by namespace + workflow name + key. The new four-case native test covers expected file-edit commit/cancellation owners only; it has no wrong-workflow same-key case. This is the reported violation.
- **Evidence normalization/retraction:** followed canonical source rendering in `planCapturedExtraction` through `extractionEvidencePath`, source-specific assertion identity, partial directory overlap and YAML reassert/expiry. First-`#` splitting, full-fragment decoding and `posix.normalize` make encoded hashes and dot segments converge while rejecting escape/absolute paths. Native full/partial/reassertion cases preserve annotations and owner content.
- **Repository subjects:** traced captured repository ID resolution to existing root `AGENTS.md`, projection merge, Git filtering/staging, and serving-path metadata. Removing only the old `AGENTS.md` exclusion admits metadata updates while `.agents/`, linked declarations and connector mirrors remain protected; the native parameterized test verifies both ordinary and repository subjects without replacing prose/front matter.
- **Ancillary surfaces:** inspected ADR/status review corrections, committed red/green/final evidence, required-contract inventory and CI timeout-only change. Reported results were not rerun.

## Cumulative Fowler disposition

- **Mysterious Name (2):** `sourceId`/`evidenceKey` obscures one evidence identity; `contentSyncWorkflowRunId` spans proposal/setup and content ownership.
- **Repeated Switches (1):** connector lifecycle parsing, binding and publication retain repeated provider dispatch.
- **Duplicated Code (6):** typed-write admission; connector admission; GitHub credential issuance; conversation preparation/publication; captured-source JWT construction in four clients; duplicated backend/codesearch published-checkout SQL.
- No additional Feature Envy, Data Clumps, Primitive Obsession, Shotgun Surgery, Divergent Change, Speculative Generality, Message Chains, Middle Man or Refused Bequest judgment survived documented design constraints.

## Counts

- Documented-standard violations: **1**
- Blocking findings: **1**
- Fowler heuristic judgments: **9 cumulative**
