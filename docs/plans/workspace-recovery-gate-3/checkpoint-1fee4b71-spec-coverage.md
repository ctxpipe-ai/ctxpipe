# Coverage ledger — Spec — `bb24210c...1fee4b71`

## Review boundary

- Fixed base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`.
- Pinned target: `1fee4b7142bd89ecd4e8280315c97dfb08fe665e`.
- Inspected the three-dot diff and complete base-to-target commit log. Every source read used `git show 1fee4b71:<path>`; moving worktree content was excluded.
- Review-only: no repository mutation and no test execution.

## Specification traced

- `docs/plans/workspace-chat-recovery.md:642-659`: Gate 3 durable/native broker, credential ownership, and explicit adversarial review of conversation publishing.
- `.ai/memory/decisions/ADR-033-native-durable-write-workflows.md:7,11-25`: workflow ownership, credential boundary, binding checks, pause behavior, hydration ownership, and session-branch support.
- `.ai/scratchpad/git-backed-projects/issues/10-ingest-to-git-write-protocol.md:39,43-48,64,68-82,119-132`: immutable target, pause/replay, no-op, broker credentials, non-FF, hydration.
- Supporting locked chat lifecycle `issues/14-worktree-and-agent-change-lifecycle.md:68-104`: explicit brokered session publication, relink generation check, branch lease, fresh-data behavior, sandbox destruction and size.
- `docs/plans/workspace-recovery-gate-3/status.md:381-389` and `write-path-audit.md:1-30`: claimed evidence and declared incomplete inventory.

## Prior findings rechecked

- `models/workspace-write-jobs.ts:213-227`: `claimPausedWriteJob` now requires absent `workflowRunId`, excluding owned paused commands.
- `models/workspace-write-jobs.ts:563-593`: terminal owner reconciliation includes queued/running/paused projections.
- `routes/v1/workspace-files-routes.ts:444-488`: Files plans first and awaits typed admission; the old read-only early rejection is absent.
- `openworkflow/workflows/workspace-migration-export.ts:273-287`: completion precedes hydrate enqueue and passes `access: "read"`.
- `openworkflow/workflows/workspace-hydrate.ts:137-255,287-366`: captures completed-export planning need, reserves bootstrap/import cleanup only through successful/no-op hydrate paths, and admits each typed owner durably.
- Read corresponding native pause, Files HTTP, hydrate/export contract changes and committed evidence logs. The claimed corrections match the implementation.

## Conversation publisher interfaces and callers

- `domain/workspaces/conversation-publish.ts:33-225`: commit, object/shallow capture, authenticated conversation/current-binding checks, repository-scoped read/write token acquisition, actual-default checks, fresh Git reconstruction, explicit native session-ref lease, error sanitization and local remote-ref update.
- `models/github-installation.ts:856-877`: write token is scoped to the selected repository with Contents write + metadata read.
- Callers exhaustively traced via `git grep pushConversationSessionBranch`: standalone `conversation-files-routes.ts:517-565`, PR `conversations.ts:755-871`, domain native tests, and HTTP native tests.
- `chat-lifecycle.ts:24-67`: PR planner correctly compares captured URL/generation/SHA/default, but only the PR route invokes it.
- `sandbox-registry.ts:20-37,64-109,428-435`, `conversation-files.ts:47-53`, and `conversation-files-routes.ts:325-393,568-600`: captured identity exists in the in-process registration, yet standalone push resolves only the handle. Memo fallback can also provide a handle without registered metadata.
- `workspace-chat-turn-runtime.ts:33-135` and `chat-runtime.ts:35-76,79-187`: clone inputs, depth-one setup, scrubbed/ignored harness data and session branch behavior.
- `conversation-publish-native.contract.test.ts:18-139`: covers credential isolation, generation rebind during credential issue, actual-default change and concurrent session-ref advance.
- `routes/v1/conversation-publish-native.contract.test.ts:24-147`: covers successful push/PR, missing sandbox, and stale metadata only on the PR route. It has no standalone stale-handle or post-push/pre-PR relink barrier and no large-tree case.

## Adversarial cases assessed

- Authenticated conversation ownership and workspace membership: enforced by `getConversation` user/org filtering and workspace argument.
- Default-branch safety: destination is a derived session ref; actual remote default checked before and after credential acquisition.
- Concurrent session update: explicit `--force-with-lease=<ref>:<observed-tip>` correctly rejects advancement.
- Credential exposure: sandbox commands use empty env; remote read/write occurs in the fresh broker directory; error strings sanitize both acquired credentials.
- Relink before credential/push: broker rejects URL/generation/connection/default drift relative to its input. It intentionally tolerates desired-SHA advance. The missing sandbox-to-input fence and post-push PR fence are findings 1–2.
- Pack integrity: object ID and shallow entries are schema-validated; `index-pack` reconstructs native objects. The whole-tree/post-hoc size behavior is finding 3.
- No-op/repeat publish: no new commit on an unchanged default tree; an already-pushed session commit remains eligible for explicit PR creation.
- Local `origin/<session>` update failure is ignored (`conversation-publish.ts:221-225`); remote lease discovery on every later publish keeps remote correctness, so this was not raised above.

## Declared open scope

Connector/config API writer cleanup, full provider/finalization identity, remaining credential readers, persisted sandbox authority/Gate 4, automatic planning remainder, legacy deletion, and Gates 4–6 remain explicitly open in the audit/status. They were not counted as new defects.
