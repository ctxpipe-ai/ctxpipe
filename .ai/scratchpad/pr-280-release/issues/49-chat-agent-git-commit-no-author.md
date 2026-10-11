# Chat agent cannot git commit in the sandbox: no author name or email

Status: done (needs a deploy to prove)
Priority: P3
Owner: claude
Blocked by: none
Created: 2026-10-11
Updated: 2026-10-11

## Context

In the ticket 37 chat turn, the agent edited a knowledge file and then tried to commit it itself.

## Evidence

- Conversation `conv_0564162ac1153f4e3336619476b5f981`, `pr-280`, 2026-10-11 01:18 UTC. The answer says: "I attempted to commit the knowledge update, but Git lacks a configured author name and email in this environment, so the change remains uncommitted."
- Commit+Push from the UI then worked (`POST .../conversations/:id/push` 200 at 01:19:35 UTC, trace `f32e7008c3ef12d71cce1647abaca922`; the branch reached GitHub).

## Expected vs actual

- Expected: either the agent does not try to commit (the product owns Commit+Push), or a `git commit` in the sandbox works with a bot identity.
- Actual: the agent tells the user about a git configuration error.

## Scope

- Decide which is right. Then either set `user.name` / `user.email` in the sandbox git config at checkout (search `apps/backend/src/domain/workspaces/` for the sandbox checkout setup), or tell the agent in its instructions that the user commits with Sync.

## Acceptance criteria

- [ ] A chat turn that edits a file does not report a git identity error.

## Comments

## Resolution

- 2026-10-11 (claude): fixed in ticket 30, commit `6276cf40` (defect 1 there; pr-280 showed the same `Author identity unknown` error). The product lets the agent commit: it commits with `git` and then calls `push_conversation_branch`. So the sandbox now has an identity. The thread setup (`WORKSPACE_CHAT_THREAD_SETUP` in `apps/backend/src/domain/workspaces/chat-runtime.ts`) sets `user.name` and `user.email` in the clone to `COMMIT_IDENTITY`, which is the identity that the backend Commit+Push uses. Test: `chat-runtime.test.ts`, "lets the agent commit in a sandbox that has no Git identity". It failed with `Author identity unknown` before the change. After the deploy, a chat turn that edits and commits a file must report no identity error.
