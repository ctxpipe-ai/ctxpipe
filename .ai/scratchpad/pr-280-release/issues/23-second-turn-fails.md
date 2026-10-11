# A second question in a chat conversation fails

Status: in review (third question fixed; confirm on the pr-280 preview after the next deploy)
Priority: P0
Owner: claude
Blocked by: none
Created: 2026-10-08
Updated: 2026-10-11

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

## Reopened: the third question fails

Linear: CTX-519.

On the pr-280 preview, the first two questions of a conversation streamed. Both answers used tools. The third send failed with `ConversationChangedError` at `workspace-chat-thread-lock.ts:88`, and each retry failed the same way.

### Cause

`openCodeTrailingUserMiddleware` runs before each model call. When the engine runs a `tanstack_*` tool, the list ends on the tool result. Then `messagesForOpenCodeChat` adds `{ role: "user", content: <prompt> }` with no id, because OpenCode reads the prompt only from a last user message. The middleware returned this list as `messages`. The engine puts `messages` on the run, and persistence saves the run's messages. Because of this, the stored transcript has a copy of the question with no id, after the tool result.

The lock reads that copy as a third stored question with the id `""`. The browser's third send has a real id in that slot, so the lock rejects it. The second send passes because the copy is written during the second turn, after the lock accepted it. A reload does not help: the copy stays in the stored transcript.

The resolution above did not find this. Its scripted model never ends a model call on a tool result, so the copy was never added.

### Resolution

- At init, `openCodeTrailingUserMiddleware` still returns the list as `messages`. At init the prompt is the question of the turn. An MCP `ctx_advisor` call sends no history, so this is the only place where its question goes into the transcript. `ctx-advisor-thread-replay.integration.test.ts` fails without it.
- Before each later model call, the middleware returns the list as `providerMessages`. Only the adapter reads `providerMessages`. The run and the stored transcript keep `messages` without the copy.
- Proof at the lock seam: `workspace-chat-thread-lock.test.ts` now uses the production middleware order, with `openCodeTrailingUserMiddleware` last, and a tool that the engine runs. "stores only the browser's questions after the engine runs a tool" sends three questions. Before the fix it failed with `ConversationChangedError`. After the fix the stored question ids are the browser's question ids, and each model call gets a user message last.
- The native OpenCode contract tests pass with real OpenCode. Three WebSocket tests in `workspace-chat-native.contract.test.ts` fail on this machine with and without the change (`"" cannot be parsed as a URL` in the Bun client). CI is the check for them.
- A conversation that already has a stored copy stays blocked, because the copy is in its transcript. Start a new conversation. `main` does not have this middleware, so production transcripts do not have the copy.
