# Gate 5 acceptance

Gate 4 closed at `9dd7b108` after green CI
[34421467470](https://github.com/ctxpipe-ai/ctxpipe/actions/runs/34421467470)
on `79670977` and both `f8e4fae9` reviews. This file is the current ledger.
Gate 6 remains pending.

Both `5df302ea` reviews archived as
[checkpoint-5df302ea-reviewer-a.md](./checkpoint-5df302ea-reviewer-a.md) and
[checkpoint-5df302ea-reviewer-b.md](./checkpoint-5df302ea-reviewer-b.md)
returned **BLOCK**. The lines below are the correction slice, not acceptance.

## Remaining work, in order

1. Correction landed, not accepted. Collection `POST /conversations` assigns
   `conv_*` identity and returns `x-conversation-id`. The same first-message
   `idempotencyKey` maps to the same id. Home and workspace compose do not
   generate client ids; retries reuse the server id or key. Destination
   `useChat` hydrates. `832e77b8` reviews still BLOCK Gate 5.
2. Correction landed, not accepted. `dispose()` closes every tracked socket.
3. Correction landed, not accepted. Routed 404 is not-found (no cache
   fallback). `composeId` / `seenRouteId` are gone. Foreign 404 is not-found.
4. Closed. Chat chrome and the files pane share `useConversationPublish`.
5. Correction landed, not accepted. PUT requires `expectedWorktreeVersion`.
   Per-path write queues, stale CAS retries until success or a non-conflict
   error, unmount flushes every dirty draft through the same map. Untracked
   fingerprint reads no longer hash empty.
6. Correction landed, not accepted. `StableRequestBudget` covers chat + Files
   + Diff + Publish and requires a chat or diff request.
7. Closed. `WorkspacePane` is composition; files and diff have their own owners.

Required Storybook Playwright `play` proof: Strict Mode single send, late error
ordering (first message then a late failure keeps history), socket cleanup of
every opened socket, reload/reconnect with visible transcript, rapid route
changes, edit then navigate (dirty editor flush), out-of-order save responses,
shared publish pending state, Pierre keyboard/focus, and a stable-state request
budget across chat, Files, Diff, and Publish.

## Correction slice

Do not add a new environment variable, a second chat engine, or jsdom
component tests. Proof stays in Storybook `play` functions.
