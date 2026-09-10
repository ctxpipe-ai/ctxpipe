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

1. Open. Home first send is the stock conversation POST
   (`startWorkspaceConversation`), awaited before navigate. Destination
   `useChat` hydrates and owns later turns. Do not auto-send.
2. Open. Dispose every conversation socket, not only the last warmed pointer.
3. Open. A routed id that 404s is "not found", not compose. Remove
   `composeId` / `seenRouteId` render-time reconciliation. Foreign workspace
   stays "not found" for both 404 and a mismatched `workspaceId`.
4. Closed. Chat chrome and the files pane share `useConversationPublish`.
5. Open. PUT requires `expectedWorktreeVersion`. Missing cache version GETs
   tree first. Unmount flush apply passes the expected base into the
   late-snapshot guard. 409 `stale_worktree` refetches and retries once.
6. Open. `StableFilesRequestBudget` must cover chat + Files + Diff + Publish
   while idle, not only tree GETs.
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
