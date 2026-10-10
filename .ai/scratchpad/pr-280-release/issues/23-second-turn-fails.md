# A second question in a chat conversation fails

Status: in review (manual check by the CTO on the pr-280 preview)
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

The thread lock (`apps/backend/src/domain/workspaces/workspace-chat-thread-lock.ts`, `onConfig`) compares the history of a send with the stored transcript. The compare ignored ids and times but kept `metadata`. `withPersistence` adds `metadata.tanstack.run.id` to a stored answer. A browser that streamed that answer does not have it. Thus each send after a live answer did not match, and the lock rejected it. A review found more shape differences after a removal of `metadata` from the compare: the browser keeps one assistant message per OpenCode text part, and the store merges them; `uiMessagesToWire` sends reasoning and tool results as separate messages; the browser sends tool calls that the stored answer does not have. Thus a first answer with reasoning, two text parts or a tool also made the second question fail. A reload hid the problem, because the reloaded messages have the run id. Ticket 19 makes the first turn stream live, so the second question always hits it.

The cause is not Vercel-specific. The per-turn OpenCode password, the earlier-turn process stop, the firewall rules and the run token revocation are not the cause.

## Resolution

- The thread lock (`workspace-chat-thread-lock.ts`, `onConfig`) now compares only the ids of the user messages. The ids of the stored questions must be the first question ids of the send, in the same order. The browser and the store keep different shapes for the same answer, so a compare of the answers cannot be correct. A question keeps its id: the browser's id is stored on the WebSocket path (ticket 19), and a reload gives the stored ids. An overlapping send or a send from a tab that has not seen a stored question is still rejected.
- Proof at the lock seam: `workspace-chat-thread-lock.test.ts` uses the real `ChatClient`, `uiMessagesToWire`, `chatParamsFromRequestBody`, `chat()` and memory persistence, with a scripted model that sends the OpenCode chunk shapes. The second question passes after a first answer with text only, reasoning then text, two text parts, text-tool-text, a JSON tool result, a tool error, and a failed run. Before the fix, four of these cases failed with `ConversationChangedError`. The same file proves that stale sends are rejected.
- Proof on the socket: `conversation-websocket-native.contract.test.ts`, "answers a second question on the same socket, with the messages the browser holds". The two stale-send rejections in `workspace-chat-native.contract.test.ts` still pass.
- Not proved here: the real browser and a real OpenCode answer on the preview. Confirm a second question after a tool-using answer there.
