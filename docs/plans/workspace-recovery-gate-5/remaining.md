# Gate 5 acceptance

Gate 4 closed at `9dd7b108` after green CI
[34421467470](https://github.com/ctxpipe-ai/ctxpipe/actions/runs/34421467470)
on `79670977` and both `f8e4fae9` reviews. This file is the current ledger.
Gate 6 remains pending.

## Remaining work, in order

1. Closed in this slice. Home submit calls `startWorkspaceConversation`
   (the existing conversation POST), seeds the conversation cache, and
   navigates to that id. `pending-workspace-compose.ts` is deleted.
   `useChat` stays the client session owner. Storybook `FirstMessageSendsOnce`
   asserts a single POST.
2. Closed in this slice. `workspaceChatWebSocket.dispose()` closes the warmed
   socket. `WorkspaceChatSession` calls it on unmount. `useChat` stays the
   client session owner. Storybook `SocketCleansUpOnLeave` asserts close.
3. Closed with the first-message slice. `WorkspaceChat` does not reconcile
   `composeId` against a process-global draft. A routed id that does not exist
   yet is compose; a persisted conversation is resume. Foreign workspace is
   "not found". Storybook `FirstMessageSendsOnce` waits for the Home composer.
4. Closed. Chat chrome and the files pane share `useConversationPublish`
   (same mutation keys + `useIsMutating`). Push/PR success writes the status
   and PR cache instead of invalidating. Storybook `SharedPublishPending`
   asserts every Commit+Push button shows Pushing… from one click.
5. Closed. Leaving the files pane flushes the pending draft onto the same
   write queue. PUT sends `expectedWorktreeVersion`; mismatch is `409`
   `stale_worktree`. Success returns tree+status+blob snapshots. The client
   applies those instead of refetching, and ignores a late snapshot whose
   base version was already replaced.
6. Closed. 400 ms tree/status pollers are gone. File writes apply the PUT
   snapshot. `StableFilesRequestBudget` asserts the files tree is not
   refetched while idle. Chat `RUN_FINISHED` invalidates tree+status once.
7. Closed. `WorkspacePane` is composition (tabs, publish, graph, settings).
   Files ownership lives in `WorkspaceFilesPane`. Diff ownership lives in
   `WorkspaceConversationDiff`.

Required Storybook Playwright `play` proof: Strict Mode single send, late error
ordering, socket cleanup, reload/reconnect, rapid route changes, edit then
navigate, out-of-order saves, shared publish pending state, Pierre
keyboard/focus, and a stable-state request budget.

## First slice

Home submit should call the existing authenticated conversation POST (the
first-message command), then navigate to the returned/proposed conversation
id. The destination hydrates through `useChat` persistence and must not
auto-send via `useEffect` or `takeHomeDraftSend`. Delete
`pending-workspace-compose.ts` in the same slice.

Do not add a new environment variable, a second chat engine, or jsdom
component tests. Proof stays in Storybook `play` functions.
