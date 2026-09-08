# Gate 3 ec6 checkpoint — Standards coverage

## Identity and method

- Repository: `/private/tmp/ctxpipe-recovery-01a07aba`
- Fixed base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`
- Reviewed pin: `ec6d5340c4db91c4e888540deedddaa891ad9f58`
- Exact pin and merge base were verified. The cumulative range has 34 commits and 1,943 changed paths (+194,310/-14,363). Increment `fd7f8817d3417a9cb5c4ce3e5a46fb3b1a782fa1..ec6d5340c4db91c4e888540deedddaa891ad9f58` has 41 paths (+2,296/-63).
- Read-only review used pinned `git diff`, `git log`, `git grep`, and `git show`; the moving worktree and all test processes were excluded.

## Sources applied

- Root/backend/codesearch `AGENTS.md`; code-review skill and complete supplied Fowler baseline; TDD `SKILL.md`/`mocking.md`; source-connectors guidance.
- ADR-027/028 short transaction ownership; ADR-033 typed workflow ownership, immutable extraction, connector replay and admission recovery; current Gate 3 status.
- Tool-enforced matters and explicitly open Gate 3 acceptance inventory were excluded.

## Changed surfaces and caller trace

- **Workspace typed owner:** traced all twelve `enqueueWriteJob` branches and workflow names to job-kind persistence, `nativeWriteJobOwnerId`, admission catch, first claim and terminal reconciliation. The name convention matches every current kind; both explicit-ID and key recovery require the derived name and null version. Native negative cases create and cancel same-key wrong-name/wrong-version runs, observe failed admission with no owner pointer, and leave Git unchanged. Prior Standards blocker is closed.
- **Returned-handle guard:** traced every production caller of `runWorkflowWithWorkerWake`. The wrapper validates name/version before waking the worker. Repository recovery independently requires its fixed name/null version, and workspace recovery now does likewise. Connector config/content catch blocks instead use `findConnectorSyncOwner`; that query and subsequent activation omit namespace/version, so they can accept the handle the wrapper rejected. This is the reported blocker; current negative tests cover only workspace file edit.
- **Claims-only merge:** followed claim subject resolution through `planKnowledgeProjection`, `mergeExistingImportedMarkdown`, `updateKnowledgeMetadata`, changed-file filtering and Git publication. Omitting `body` for claim-only occupants preserves all bytes after the original front-matter delimiter, including indentation, Markdown hard-break spaces and final newlines. The parameterized native test reads raw Git output and compares the complete body suffix for ordinary and root `AGENTS.md` subjects.
- **Root evidence:** traced generated canonical links, legacy URL/relative parsing, assertion keys and full/partial retraction. `canonicalEvidencePath` maps `./`, `src/..`, empty URL fragments and a knowledge-file-relative `../..` to `""`, while rejecting absolute/parent escapes. Repository-wide assertions conservatively retain concrete source history. Expanded native reassertion cases cover the forms.
- **Connector restart:** traced immutable config input from admission through activation, durable `capture-config-binding`, provider target reload, pre-sync `assertConnectorContentSyncBinding`, PR finalization CAS/cleanup and no-change content admission for Linear, Notion and Confluence. Historical workflows resume after the capture step; branch/generation changes fail before publication. Thirty reported native cases cover the providers; they were not rerun.
- **Ancillary:** inspected ADR/index/status updates, committed red/green/final evidence and type summaries.

## Cumulative Fowler disposition

- **Mysterious Name (2):** `sourceId`/`evidenceKey` obscures one evidence identity; `contentSyncWorkflowRunId` spans proposal/setup and content ownership.
- **Repeated Switches (1):** connector lifecycle parsing, binding and publication retain repeated provider dispatch.
- **Duplicated Code (6):** typed-write admission; connector admission; GitHub credential issuance; conversation preparation/publication; captured-source JWT construction in four clients; duplicated backend/codesearch published-checkout SQL.
- No additional Feature Envy, Data Clumps, Primitive Obsession, Shotgun Surgery, Divergent Change, Speculative Generality, Message Chains, Middle Man or Refused Bequest judgment survived documented design constraints.

## Counts

- Documented-standard violations: **1**
- Blocking findings: **1**
- Fowler heuristic judgments: **9 cumulative**
