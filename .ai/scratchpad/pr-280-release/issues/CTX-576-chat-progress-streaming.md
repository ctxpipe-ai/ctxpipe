# CTX-576: Chat progress while streaming

**Status:** fixed on `ui/ctx-576` (not pushed).

## Causes and fixes

1. **Label order.** The backend sends `sandbox-setup` "starting" after `RUN_STARTED` on each turn. Only the first message of a new conversation started the UI in the "starting" phase. A follow-up turn showed "Thinking", then "Setting up sandbox", then "Thinking". Fix: each send starts in the "starting" phase (`WorkspaceChatSession.tsx`). The counter rules did not change.
2. **Space under the counters.** The counters and the status line were two items of the message column (`gap-5`). Fix: the status line is inside the activity block (`gap-2`) until the reply text starts. Then it moves after the reply, as before. The activity block keeps its key, so the open log stays open.
3. **Log order.** The OpenCode adapter sends a separate reasoning message for each thought, but no step events. The `@tanstack/ai` stream processor keeps its first `currentThinkingStepId` for the full message, so all later reasoning goes into the first thinking part, above the tool calls. Fix: the workspace chat connection sends a `STEP_STARTED` (step name = reasoning message id) before each `REASONING_MESSAGE_START`, on `subscribe` and on `joinRun` (`workspaceChatWebSocket.ts`).
4. **Tool details.** OpenCode first sends a tool part as "pending" with an empty input. The adapter opened the call at that state, so `TOOL_CALL_ARGS` was always `{}`. The stored transcripts on the preview also have `{}` for each tool call. Fix: the existing `@tanstack/ai-opencode` patch now skips the "pending" state and opens the call at "running", when the input is known. This is a 1-line addition to the existing vendor patch; no other location has the input. The tool name now has a medium weight; the detail stays regular mono.
5. **Scroll on open.** `use-stick-to-bottom` scrolls to the bottom on a positive resize when the view is at the bottom. Opening the log grew the content, so the thread scrolled away. Fix: opening the log calls `stopScroll()`. When the user scrolls back to the bottom, the stick starts again.
6. **Gap to the first log item.** The activity block used `gap-1`; the log items use `gap-2`. Fix: `gap-2` for both.

## Tests

- `apps/backend/src/domain/workspaces/opencode-stream-translate.test.ts`: a pending then running tool part gives one `TOOL_CALL_ARGS` with the input. Red before the patch change.
- Stories (golden): `FollowUpShowsSandboxSetupFirst`, `LogKeepsStreamOrder` (WorkspaceChat, real chat client through the fake socket); `ChatProgressSpacing`, `OpeningLogKeepsScroll` (ConversationThread). Each one failed on the earlier code.

## Open risks

- Stored transcripts (hydration after reload) still have `{}` tool input for old turns, and the server persistence can still group reasoning. Only new live turns get the fixes.
- The patch change adds to vendor patch debt; it is a candidate for the upstream PR of the same patch.
