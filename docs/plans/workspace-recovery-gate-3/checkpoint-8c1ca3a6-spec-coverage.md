# Gate 3 runner-retirement checkpoint — Spec coverage ledger

## Pin and contracts

- Reviewed exact `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...8c1ca3a69717e27be87dcd9f436d8a1f2ca7386c`, its 19-commit log, and the focused delta from `c293853e`. Product reads used target-qualified `git show`, `git grep`, and pinned diffs; no moving-worktree content was used.
- Applied the repository code-review skill's Spec axis, root/backend instructions, recovery-plan Gate 3 lines 642–659, ticket 10 lines 39–132, migration ticket 12 lines 65–99, ADR-033 lines 7–27, and pinned status/write-path audit.

## Export follow-up and cutover tracing

- Traced migration export through completed replay, source capture, acquired Git pack, deterministic projection, knowledge-path publication, direct/no-op/semantic completion, common hydrate enqueue, current-tip refresh, Git file read, bootstrap/import-key remainder calculation, capped reservation, and typed admission.
- Verified completion and path projection precede hydration; hydrate and follow-up enqueue keys are stable; replay returns through the common tail; planner deduplicates queued/paused same-SHA intents and carries `rootSha`, attempt, and remainder.
- Verified `getMigrationExportSha`, `listMigrationExportShas`, and export-intent discovery join the current workspace on generation, repository URL, GitHub connection, and default branch. Extraction captures cutover plus path state in its repeatable-read snapshot. Cleanup checks a completed same-binding export before acquisition.
- Finding 1 records the uncovered ordering gap: enqueueing hydration yields a handle, so follow-ups are admitted without proof that hydration succeeded. The native evidence asserts creation after export completion, not after hydrate completion.

## Admission, pause, and HTTP tracing

- Enumerated all 12 kinds from `workspaceWriteJobInputSchema`: seven snapshot workflows plus explicit file edit, link/unlink, rename, connector mirror, and semantic merge branches. Each branch persists immutable kind-specific command data before `runWorkflowWithWorkerWake`; unsupported/non-GitHub bindings fail before persistence.
- Traced probe classification, full-binding permission CAS, captured-SHA reuse, paused admission, typed workflow ownership, enqueue-lost-ACK cleanup, workflow claim, acquisition/push wait loops, semantic child ownership, and terminal reconciliation.
- Verified transient probe failures become `unknown` and can be admitted by the shared function; stale probe CAS returns no admission. Finding 2 is specifically the Files route's older status gate, corroborated by its retained read-only rejection contract.
- Traced periodic write probing through paused-row listing, claim, enqueue reconstruction, and native idempotency. Finding 3 covers the cancel-before-claim interleaving missing from the cancellation proof, which explicitly calls reconciliation before any resume.

## Interfaces, callers, and removal

- Traced `enqueueWorkspaceWriteCommit` callers in workspace create/relink/rename, Files, link/unlink, hydrate planner, export tail, and tip check. Fire-and-forget setup/link behavior was recorded as existing/open lifecycle scope rather than relabeled here.
- Verified the prior Linear caller no longer wraps `finalizeLinearBindingAfterContentWorkflow`; that model asserts no ambient transaction and owns its locked short transaction.
- Searched production TypeScript for the removed generic workflow, runner, agent, transforms, and worktree executor symbols. No executable caller remains. `job-worktree.ts` now contains handle types only; retained sandbox code is used by semantic provider/conversation/explorer paths.
- Inspected CLI discovery expectations, affected native contracts, status evidence, type/policy claims, and deletion list. No heavyweight suites were rerun.

## Explicit exclusions

- Excluded the pinned audit's declared incomplete connector generation/config/provider finalization and setup terminal failures; session publisher; empty-repository initialization; unrestricted read/config-PR credentials; canonical extraction inputs; rename lineage cap; handoff ACK/output binding and provider topology; remaining registry/metadata cleanup; and Gates 4–6.
