# Gate 3 paused-write checkpoint — Spec coverage ledger

## Pin and governing contracts

- Reviewed exact `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...e9f12641bd7a8cf9292db13a84f1c7199b982bc5`; enumerated all 15 commits. All source and documentation reads used `git show` or pinned diffs, never mutable worktree content.
- Applied `.cursor/skills/code-review/SKILL.md` Spec axis and pinned root/backend `AGENTS.md`.
- Read recovery-plan Gate 3 lines 642–659, ADR-033 lines 7–24, locked ticket 10 lines 39, 43–48, 54, 64, 68–82, 96–132, and chat/worktree locks for session-branch-only publication. Read pinned `status.md` and `write-path-audit.md`; their declared future work was excluded from findings.

## Prior finding and permission admission

- `persistWriteStatus` now compares id/org plus captured generation, URL, connection, default branch and desired SHA and returns whether the CAS applied (`models/workspaces.ts:1578-1608`).
- Traced enqueue probing, tip-check probing and legacy error persistence. Enqueue returns unavailable on CAS loss; tip-check neither records the stale status nor claims paused rows. The native relink-during-probe contract releases a new-binding workflow and asserts no credential or push. Prior stale-probe P1 is resolved.
- Traced repository-scoped read probe, app-auth installation-permission fallback, and actual write-token boundary. No probe-side write credential found.

## Native pause/resume surfaces

- Traced `acquireWorkspaceWriteRevision`: same binding may acquire the captured old SHA; relink/default change rejects; non-writable returns a typed null before credential acquisition.
- Traced `attemptWorkspaceCommit`: actual remote containment remains first for lost-ACK recovery; recognized credential/native-push 401/403/404 and GH006/GH013/ruleset errors map to binding-CASed read-only state and `paused`; tip advance remains distinct.
- Inspected all twelve typed workflows: bootstrap, UI edit, import cleanup, claims upgrade, valid-from, folder map, link/unlink, migration export, rename, extract, connector mirror and semantic merge. Each has durable one-minute acquisition and broker-push wait loops and preserves the same job owner/prepared SHA. Semantic handoff validation now accepts a paused parent.
- Traced paused-intent reconstruction through `enqueueInputFromPausedJob`, recorded command selection during re-admission, exact binding comparison, original SHA reuse, deterministic workflow idempotency and semantic child ownership.
- Found the common no-op gap: all twelve call `refreshWorkspaceWriteRevision`; its live `writeStatus === writable` requirement is outside both new pause loops and conflicts with no-op/lost-access behavior. No recorded test changes access after acquisition on an unchanged transform.

## Conversation capability and UI

- Traced `workspaceAllowsConversationEdits` through chat turn runtime, permission handler normalization, prepare/branch checkout, conversation Files PUT/commit-push, PR publication, and workspace serialization. Protected-default reason permits only the session flow; repository permission loss denies it. Sandbox policy still hard-denies `git push`, Contents:write, and commits outside `ctxpipe/chat/*`/onto default.
- Traced required `conversationWritable` response through list/detail serialization and optional UI compatibility type. `WorkspaceChatSession`, pane publish chrome and Files editor all consume the capability via the shared helper. Five helper tests and the native HTTP/PostgreSQL sandbox test cover positive protected-default and negative permission-loss behavior.

## Evidence reviewed, not rerun

- Inspected recorded 46 broker/merge/pause/wire passes, 39 remaining typed/planner/HTTP passes, 17 policy and five UI helper passes, backend 141/UI 230 diagnostic baselines, Biome/proof-policy results. CI `34246462358` was running at the requested pin.

## Declared open scope (not findings)

Connector/publisher integration, remaining planning kinds, provider integration, alternate writer/credential migration and legacy deletion, plus Gates 4–6.
