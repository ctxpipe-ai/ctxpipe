# Gate 5 review B — BLOCK at `5df302ea`

Fixed point: `cffcbc82`. Reviewed HEAD: `5df302ea`.
Range: 13 commits, 30 files.

## Verdict

**BLOCK.** Do not write `CLOSE_GATE_5`.

## Blockers

1. **First-message ownership.** Same as reviewer A: Home POST/drain outside
   `useChat`, client-generated id, navigate without await.
2. **Optional CAS.** Same as reviewer A.
3. **Required plays do not match their names.** Same as reviewer A.
4. **Foreign workspace vs compose.** Production GET with `workspaceId` returns
   **404**. `WorkspaceChat` treats 404 as **compose**. The foreign story injects
   a 200 with a foreign `workspaceId`, which production does not return.
5. **Render-time route repair.** `WorkspaceChat` still has `composeId` /
   `seenRouteId` reconciliation during render.
6. **Socket leak.** `dispose()` tracks only one `warmed` pointer. `joinRun()`
   resume can replace it and leak the original socket. `SocketCleansUpOnLeave`
   only asserts `closeCount` increased.

## Note

This archive records the review that blocked Gate 5 at `5df302ea`. Later commits
on this branch are the correction slice.
