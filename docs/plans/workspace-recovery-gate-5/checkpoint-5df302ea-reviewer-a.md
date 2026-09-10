# Gate 5 review A — BLOCK at `5df302ea`

Fixed point: `cffcbc82`. Reviewed HEAD: `5df302ea`.
Range: 13 commits, 30 files.

## Verdict

**BLOCK.** Do not write `CLOSE_GATE_5`.

## Blockers

1. **First-message ownership.** `HomeComposer` still generates `conversationId`,
   seeds Query cache, fires `startWorkspaceConversation` (`POST` + drain AG-UI)
   outside `useChat`, and navigates without awaiting. `startWorkspaceConversation`
   returns `void`. This is not one idempotent server command, and `useChat` is
   not the first-turn owner.
2. **Optional CAS.** `expectedWorktreeVersion` is optional on PUT. Writes
   without a cached version skip `409`. Unmount flush apply does not always pass
   the expected base into the late-snapshot guard.
3. **Required plays do not match their names.** Edit-then-navigate is create then
   leave (PUT already done). Out-of-order is two serialized creates. Late error
   fails a send on an existing thread, not first-message then late error. Stable
   budget counts tree GETs only. Pierre play has no focus assertion. Reload only
   counts new sockets.
4. **Hydrate empty-on-error.** `workspaceChatWebSocket.ts` `hydrate()` uses bare
   `fetch` and turns every non-2xx into an empty thread.

## Note

This archive records the review that blocked Gate 5 at `5df302ea`. Later commits
on this branch are the correction slice.
