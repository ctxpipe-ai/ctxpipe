# Coverage ledger — Spec review of `ec6d5340`

## Boundary

- Repository: `/private/tmp/ctxpipe-recovery-01a07aba`
- Fixed base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`
- Pinned target: `ec6d5340c4db91c4e888540deedddaa891ad9f58`
- Cumulative diff and log were inspected at the exact target; the focused increment was `fd7f8817d3417a9cb5c4ce3e5a46fb3b1a782fa1...ec6d5340c4db91c4e888540deedddaa891ad9f58`.
- Increment commit: `ec6d5340 Gate 3: fence config resumes and typed native ownership`.
- Read-only review: all repository content came from pinned `git show`, `git grep`, and `git diff`; no implementation changes or native test runs.

## Spec sources

- `docs/plans/workspace-chat-recovery.md:642-659` — typed durable workflows and OpenWorkflow retry/resume authority.
- `.ai/scratchpad/git-backed-projects/issues/10-ingest-to-git-write-protocol.md:9-33,43-48,66-82,94-110` — canonical Git writes, one-job semantics, retry ownership.
- `.ai/memory/decisions/ADR-033-native-durable-write-workflows.md:18,25,44-53` — typed name/version ownership, connector captured bindings, exact body preservation, root evidence normalization.
- Pinned `docs/plans/workspace-recovery-gate-3/status.md` and retained fd7 Spec report/coverage — claimed fixes, evidence, and explicitly open acceptance inventory.

## Previous finding closure

### Claims-only `AGENTS.md` bytes

- `domain/workspaces/migration-export.ts:96-120,672-689`: `mergeExistingImportedMarkdown` now accepts an absent body and uses `original` directly; claims-only projection omits `body`. `updateKnowledgeMetadata` therefore edits YAML while retaining the original body suffix.
- `domain/workspaces/write-extract-native.contract.test.ts:629-718`: ordinary and root `AGENTS.md` subjects contain leading blank lines, an indented instruction, trailing spaces, and extra final newlines; the assertion compares the entire post-front-matter suffix.
- Result: fd7 P1 closed.

### Root evidence identity

- `domain/workspaces/retract-extraction.ts:13-52`: shared `canonicalEvidencePath` normalizes POSIX segments, rejects upward/absolute paths, removes a trailing slash, and maps `.` to repository root `""`.
- `domain/workspaces/plan-extraction.ts:68-80`: this canonical result remains the merge identity input.
- `domain/workspaces/write-extraction-retraction-native.contract.test.ts:140-310`: root URL `#./`, URL `#src/..`, and relative `../..` converge with repository-only provenance; the fixture retains the existing conservative rule that repository-wide assertions do not disprove specific-file evidence.
- Result: fd7 P2 closed.

## Connector capture/restart fence

- `models/connector-content-sync.ts:15-24,99-102,352-408`: full non-secret binding contains provider, repository, branch, provider workspace/cloud and Atlassian base URL. Capture validates the immutable input against current state; pre-sync assertion validates generation, enablement/install state, and full binding.
- `openworkflow/workflows/{linear,notion,confluence}-sync-config.ts`: each workflow persists `capture-config-binding`, reloads its provider target, compares repository/branch, then calls `assertConnectorContentSyncBinding` inside the provider-sync durable step. Credentials remain loaded inside that step rather than durable outputs.
- `openworkflow/workflows/connector-config-native.contract.test.ts:302-525`: prior implementation captures, sleeps, is stopped, target branch changes, and production implementation resumes. All three providers fail without admitting content work. The persisted capture is replayed rather than recomputed.
- Result: the claimed capture/restart binding fence is implemented for the tested branch rebind and the full pre-sync assertion covers other binding fields.

## Typed owner/caller audit

- `openworkflow/client.ts:13-31`: returned handle name/version is checked before worker wake.
- `models/workspace-write-jobs.ts:569-619,738-775`: workspace-write lost-ACK and terminal recovery now require derived typed workflow name and null version. The new wrong-name/wrong-version contracts exercise this surface.
- `openworkflow/enqueue-connector-{config,content}-sync.ts`: both callers catch wrapper failure and perform native-owner rediscovery.
- `models/connector-content-sync.ts:160-183,215-230,335-349`: existing owner reuse, activation, and rediscovery omit version, creating the report’s P1 bypass for all three connector providers and both config/content purposes.

## Known open acceptance scope

The pinned status still records live producer, true-unborn/bootstrap, allocation and model-loss proof, semantic/admission uncertainty, cleanup, and other Gate 3 inventory. Those items were not treated as newly introduced findings or as accepted completion.

## Counts

- P1: 1
- P2: 0
- Total actionable Spec findings: 1
- Prior fd7 findings verified closed: 2 of 2
