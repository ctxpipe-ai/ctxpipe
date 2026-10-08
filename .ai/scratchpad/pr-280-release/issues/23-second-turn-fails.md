# A second question in a chat conversation fails

Status: review: confirm on the preview after the next deploy
Priority: P0
Owner: claude
Blocked by: none
Created: 2026-10-08
Updated: 2026-10-08

## Context

A tester on the pr-280 preview (hosted, Vercel sandboxes) cannot ask a second question in a conversation. The first answer streams. The second send fails.

## Cause

Evidence:

- The Railway stdout of the pr-280 backend and worker has no chat lines. Product logs go to OTLP only. The HyperDX and Langfuse MCP keys were rejected (HTTP 401), so the preview logs of the failed turn were not read.
- A native contract test sends two turns on one conversation WebSocket, with the messages that the browser holds after it streamed the first answer. The second turn ends with `RUN_ERROR` "Conversation changed during another send; reload before retrying" (`ConversationChangedError`). The UI shows this error.

The thread lock (`apps/backend/src/domain/workspaces/workspace-chat-thread-lock.ts`, `onConfig`) compares the history of a send with the stored transcript. The compare ignored ids and times but kept `metadata`. `withPersistence` adds `metadata.tanstack.run.id` to a stored answer. A browser that streamed that answer does not have it. Thus each send after a live answer did not match, and the lock rejected it. A reload hid the problem, because the reloaded messages have the run id. Ticket 19 makes the first turn stream live, so the second question always hits it.

The cause is not Vercel-specific. The per-turn OpenCode password, the earlier-turn process stop, the firewall rules and the run token revocation are not the cause.

## Resolution

- `transcriptContent` in `workspace-chat-thread-lock.ts` also ignores `metadata`. Role, content and tool calls are still compared, so an overlapping stale send is still rejected.
- Proof: `apps/backend/src/routes/v1/conversation-websocket-native.contract.test.ts`, "answers a second question on the same socket, with the messages the browser holds". It failed with the error above before the fix and passes after it. The test "rejects an overlapping stale send without replacing the accepted transcript" still passes.
- Not proved here: a turn with tool calls or reasoning. The native fixture model gives text only. Other metadata differences are now ignored, but a difference in the tool-call shape between the browser and the store would still reject a send. Confirm with a tool-using second turn on the preview.
