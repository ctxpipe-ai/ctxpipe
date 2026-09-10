# Gate 5 acceptance

Gate 4 closed at `9dd7b108` after green CI
[34421467470](https://github.com/ctxpipe-ai/ctxpipe/actions/runs/34421467470)
on `79670977` and both `f8e4fae9` reviews. This file is the closed ledger.
Gate 6 remains pending.

Both independent Sol reviews of `ccd7839f` from fixed point `cffcbc82`
returned **PASS** with empty blockers:
[checkpoint-ccd7839f-reviewer-a.md](./checkpoint-ccd7839f-reviewer-a.md) and
[checkpoint-ccd7839f-reviewer-b.md](./checkpoint-ccd7839f-reviewer-b.md).

CLOSE_GATE_5

## Accepted evidence

1. Collection `POST /conversations` assigns `conv_*` identity, scopes the
   idempotency hash to caller and workspace, and skips a second stream when
   that conversation already has turns. Home and workspace compose always retry
   the collection command. Destination `useChat` hydrates; no auto-send.
2. `dispose()` closes every tracked socket.
3. Routed 404 is not-found. Chrome resets by remounting
   `WorkspaceSurfaceSession`. `WorkspaceChatSession` is the hydrated thread
   only — no composing owner and no render-time identity repair.
4. Chat chrome and the files pane share `useConversationPublish`.
5. PUT requires `expectedWorktreeVersion`. Snapshots apply the version
   `mutationFn` sent. Stale CAS retries until a non-conflict error. Unmount
   flushes every dirty draft. Conversation diff queries invalidate on write.
6. `StableRequestBudget` covers chat + Files + Diff + Publish.
7. `WorkspacePane` is composition; files and diff have their own owners.

Required Storybook Playwright `play` proof passed on this host:
Strict Mode single send, production late-error compose, socket cleanup, rapid
routes, edit-then-navigate dirty flush, out-of-order distinct dirty bodies,
Pierre keyboard/focus on the selected billing row, and shared publish / budget
stories already accepted in earlier slices.

## Closed work

Do not add a new environment variable, a second chat engine, or jsdom
component tests. Proof stays in Storybook `play` functions.
