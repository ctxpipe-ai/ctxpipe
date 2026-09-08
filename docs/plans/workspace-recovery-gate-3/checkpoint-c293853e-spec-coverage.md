# Gate 3 publication checkpoint — Spec coverage ledger

## Pin and governing contracts

- Reviewed exact `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...c293853e9d062b2cf23c5d89805ebc9c7737bdcd`, all 18 commits, and the full delta from `6bae4242`. Repository reads used target-qualified `git show`, `git grep`, or pinned diffs; no moving-worktree content was treated as checkpoint evidence.
- Applied the repository code-review skill's Spec axis, root/backend `AGENTS.md`, connector guidance, recovery-plan Gate 3 lines 642–659, ticket 10 lines 39–132, ADR-025 lines 15–20, ADR-033 lines 11–25, and the pinned status/write-path audit.

## Slack terminal publication

- Traced webhook admission and enqueue-only failure handling into target capture, working status, model intent, deterministic provider capture, native mirror child, final status update/fallback, and parent terminal result.
- Reviewed `getSlackMentionMirrorFailure`: it joins the owning run and step attempt by namespace/run id, fences workflow name plus org and connection input, requires the exact workflow-kind `commit-slack-mirror` attempt with `status = failed`, and returns no failure for suspended/running child waits.
- Confirmed the catch rethrows when no authoritative failed attempt exists. A terminal child becomes a failed Slack outcome, the final status step requires either update or fallback publication, and the parent then remains truthfully failed. Logger scope now covers workflow and connection.
- Inspected the native five-mode proof: bare and model-selected capture, capability-only no-write, failed child with update, and failed child with fallback reply. It disables the connector during real broker credential admission, observes no Git commit, and verifies the parent ends failed after the failure status is sent.

## Connector completion fencing

- Traced full-sync parent captures and finalizer calls for Linear, Notion, and Confluence; all pass the originally captured repository id and branch. Incremental parents do not perform setup finalization.
- Linear/Notion finalizers acquire the existing advisory lock, lock the authoritative connection row, parse the current binding, and require enabled + `initial_sync` + captured repository/branch before updating. Directory projection occurs only after the transaction commits.
- Confluence performs one conditional update over connection, phase, enabled, repository, and branch, so the predicate itself is the compare-and-swap. Its table-backed target does not need a secondary directory projection.
- Followed every production caller of the three changed finalizer signatures and all production callers of `updateNotionConnectionTokens`. Token refresh now rejects an ambient org transaction, performs select-for-update and encrypted token update in its own short transaction, then projects the committed row. Route and full/incremental sync callbacks no longer wrap it in a broader transaction.
- Inspected provider/status matrices and real post-push rebind barriers for all three connectors. The proofs retain the newly bound `initial_sync` state after the old mirror completes. Full generation, config, and provider identity are explicitly declared follow-up scope.

## Export completion, projection, and hydration

- Traced migration-export admission, legacy source capture, immutable Git acquisition, deterministic transform, path recording, no-op refresh, stage/validation/commit, broker publication, semantic handoff, completion, publication refresh, and idempotent hydrate enqueue.
- `persistWriteJobKnowledgePaths` requires the running owner. `persistWriteJobCommitSha` and `persistMigrationExportNoOp` complete the job and call `projectCompletedKnowledgePaths` inside the same org transaction. Projection locks the workspace, checks the current binding, merges same-binding assignments, and writes the compact path state before commit returns.
- Direct commit completes/project first, then reaches the common hydrate tail. Ordinary no-op records `exportTipSha` and projects first. For semantic ownership, the child identifies the immutable parent kind, suppresses its generic early hydrate, and returns to the export parent; committed and no-op results are then completed/projected before the same common hydrate tail.
- Completed-command replay returns the durable result from `completedWorkspaceWrite` but remains inside the outer workflow body, refreshes canonical publication, and enqueues with `${jobId}:hydrate`; repeated replay deduplicates.
- Inspected the native evidence for direct export, empty no-op, raced semantic no-op, completion-before-enqueue restoration, timestamp ordering, one-commit/no-extra-commit behavior, and retained extraction reuse of projected paths.

## Interface and exclusion audit

- Reviewed the shared Git object-id schema extraction (40/64 hex), connector scope schema/callers, workspace semantic merge's export-owner branch, changed tests, ADR/status/audit claims, and the stated type/native evidence. No heavyweight suite was rerun.
- Excluded the audit's declared full connector generation/config/provider finalization and setup failure projection; export bootstrap/import-cleanup follow-ups; remaining planner work; alternate/default writers and credentials; provider topology; generic runner/legacy deletion; and Gates 4–6.
