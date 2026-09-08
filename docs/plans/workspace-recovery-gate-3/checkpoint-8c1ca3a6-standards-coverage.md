# Standards coverage — `8c1ca3a69717e27be87dcd9f436d8a1f2ca7386c`

## Identity and method

- Fixed base `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`; pinned target `8c1ca3a69717e27be87dcd9f436d8a1f2ca7386c`; merge base confirmed and all 19 commits enumerated. New increment: `8c1ca3a6 Gate 3: own paused admission and retire the generic write runner`.
- Used pinned `git diff`, `git log`, `git show TARGET:path`, and `git grep TARGET`; ignored the moving checkout. No product edits or test execution.
- Applied root/backend `AGENTS.md`, ADR-027/028/033, accepted status/audit, TDD/mocking proof rules, and every supplied Fowler smell. Tool-enforced formatting was excluded.

## Changed surface

The increment changes 32 source/test/standards files plus evidence. Production review covered commit subjects, hydrate planner, sandbox/worktree types, write command/intent/resume/status helpers, export models, write-job persistence, admission, Linear finalization, export/cleanup workflows, and Files route. Nine generic workflow/runner/agent/transform/worktree files/tests are deleted. ADR, glossary, lesson, mocking guide, status, and audit were read as standards/spec context.

## Interface and caller ledger

### Typed admission and pause ownership

- `enqueueWriteJob` / alias `enqueueWorkspaceWriteCommit` return `{started}` and dispatch all 12 kinds (`enqueue-workspace-write-commit.ts:104-380`). Production callers traced: hydrate, migration export, tip check, Files, linked-repository routes, and workspace retry/setup routes.
- Admission probes and persists the exact revision, uses `admissionStatus` queued/paused, creates the typed run with job ID idempotency, and uses `failUnscheduledWriteJob` only after bound enqueue failure. Unsupported non-GitHub targets fail before persistence.
- `persistBoundWriteJob` preserves planner metadata, immutable payload, and one workflow owner (`workspace-write-jobs.ts:593-705`). `failUnscheduledWriteJob` checks for an already-created matching native run (`:708-728`).
- Periodic resume selects paused rows, atomically claims them queued, and schedules outside the org transaction (`workspace-tip-check.ts:81-107`). The exact owner is retained by idempotency. The queued-state reconciliation hole is reported in the main review; the supplied cancellation test covers stable paused → canceled, not claim → queued → canceled.
- Files now awaits the result and returns 409 when no run was durably admitted (`workspace-files-routes.ts:445-499`); the new HTTP contract asserts this literal behavior.

### Export follow-ups and cutover

- After completion and hydrate admission, migration export refreshes the current binding, reads committed Markdown with a scoped credential, plans bootstrap plus import-key remainder, and reserves through `reserveHydrateWrites` (`workspace-migration-export.ts:279-369`). Each command is a named durable admission step.
- `reserveHydrateWrites` checks generation, URL, connection, branch, and exact SHA under the workspace row lock; it retains per-kind root SHA, attempt, remainder, cap, deterministic job ID, and starts reservations paused (`workspace-write-planning.ts:11-135`). Existing hydrate is its only other caller.
- `currentExportBinding` scopes completed cutover and intent queries by current generation/URL/connection/default branch (`workspace-write-jobs.ts:338-404`). Callers traced: extraction’s repeatable-read projection, cleanup guard, tip-check discovery, and tests.
- Import-key cleanup requires the matching completed cutover before acquisition (`workspace-import-key-cleanup.ts:74-101`). Native export tests cover direct/replay reservations and executing cleanup; extraction tests cover stale-binding exclusion and identity preservation.

### Linear correction

- `linear-sync-content.ts:181-188` now calls the finalizer directly.
- `linear-connector.ts:1253-1306` asserts no ambient tenant transaction, owns its locked transaction, then updates the connection directory after commit. The three supplied full/entity/rebind cases exercise this boundary.

### Generic-runner retirement

- Deleted: `workspace-write-commit`, `write-runner`, `write-job-agent`, `write-commit-files`, worktree execution, and their obsolete tests.
- `WorkspaceWriteKind` now belongs to `write-jobs.ts`; all type consumers were traced. No deleted runner/workflow/agent/transform symbol remains in production.
- `job-worktree.ts` retains only handle/exec/fs types used by conversation files/publish, chat PR, sandbox registry, and adapter. `adaptTanstackHandle` has live conversation/explorer callers. `ensureJobSandbox`/`createTanstackJobSandbox` currently have test-only callers; their removal is treated as the explicitly declared final registry cleanup rather than a checkpoint omission.

## Evidence disposition

Inspected committed evidence for 13 cleanup/export/Linear tests; 36 corrected targeted checks; typed read-only ownership, paused cancellation, and Files HTTP checks; CLI discovery of all 12 typed writers and absence of the generic workflow; backend type baseline of 140; scoped Biome and proof policy. Evidence was not rerun.

## Fowler baseline disposition

- Reported: **Duplicated Code** in typed admission branches; remaining **Data Clumps** in connector finalizer inputs.
- The earlier copied provider Git-race harness also remains, but is subsumed under the existing duplication cleanup rather than counted again.
- Deferred by explicit audit: test-only legacy job-sandbox construction (**possible Speculative Generality**) pending conversation/registry migration.
- No additional actionable Mysterious Name, Feature Envy, Primitive Obsession, Repeated Switches, Shotgun Surgery, Divergent Change, Message Chains, Middle Man, or Refused Bequest.

## Declared exclusions

Full connector lifecycle/setup projection; remaining bootstrap/extraction planning metadata; conversation/config-PR writer and credential migration; provider topology; retained registry/handle cleanup; and terminal Gate 3 acceptance remain open and were not counted as missing.

## Counts

- Documented-standard violations: **2**
- Heuristic smells: **2**
- Implemented-scope blockers: **1**
