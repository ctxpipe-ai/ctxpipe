# The first turn of a new conversation does not stream

Status: done
Priority: P0
Owner: claude
Blocked by: none
Created: 2026-10-07
Updated: 2026-10-07

## Context

On the pr-280 preview, a user starts a new conversation and sends a message. The UI shows "Setting up sandbox". When that indicator goes away, the UI shows nothing: no reasoning, no tool use, and no answer. After a reload, the full turn is there. Thus the turn runs and the backend stores it, but the browser does not get the live stream.

Expected: "Setting up sandbox", then "Thinking", then each tool call, then the streamed answer, and the turn ends with `RUN_FINISHED`, all without a reload.

## Cause

The first turn did not use the session's chat stream.

1. `openWorkspaceConversation` (`apps/ui/src/features/workspaces/start-workspace-conversation-ui.ts`) navigated to the new conversation and then sent the first message with its own `POST /conversations`. `startWorkspaceConversation` (`queries.ts`, about line 207) read the full SSE body with `await res.text()` and discarded each event.
2. `WorkspaceChatSession` mounted at the navigation, before the POST created the run. Its `useChat` (`persistence: true`) hydrated once at mount: `GET /conversations/<id>/chat` answered 404 or `activeRun: null`. The client does not hydrate again, so it never joined the run.
3. The POST run has no WebSocket durability log (`workspaceChatHttpResponse` uses SSE without `durability`), so a rejoin over the socket was not possible.
4. While the POST body was open, the start state stayed `"starting"`, so the UI showed "Setting up sandbox" for the full turn. When the POST ended, the indicator went away and the thread showed only the user message. The updated detail went into `initialMessages`, which `useChat` reads only once.

The golden story `LateErrorDoesNotClobberSuccess` hid this: its hydrate handler returned the finished transcript at mount.

Evidence: the new golden story `FirstTurnStreamsLive` (stored transcript empty while the turn runs, as on a real backend) failed at commit `fcf53387` with "Unable to find an element with the text: The billing service lives in the ledger package." The thread showed only the user message. I did not read the pr-280 logs: the HyperDX MCP rejected its key in this session.

## Resolution

The first turn now goes through the same path as each later turn.

- `openWorkspaceConversation` seeds the conversation with an empty transcript, puts the message text in the query cache under `conversationStart`, and navigates. It sends nothing.
- `WorkspaceChatSession` gets that text once with `takeFirstMessage` (in a `useEffectEvent`, so StrictMode does not send twice) and calls its own `sendMessage`. The label starts at "Setting up sandbox". The turn streams on the session's WebSocket, which also has the durability log for a reload during the turn.
- If the first turn fails (for example, at capacity), the session puts the text back in the composer and reloads the conversation list, because the backend can drop a conversation with no turns. The error shows in the thread.
- The WebSocket turn now runs in the conversation's Langfuse context (`withLangfuseTurnContext`, shared with the POST path), so UI turns keep their session, user, and source tag.
- I removed `startWorkspaceConversation`, `StartWorkspaceConversationError`, the composer retry state, and the session's "Could not send / Send again" branch.
- The backend `POST /conversations` start route stays. It is a public REST route that API-key clients use. The UI does not use it now.
- Known gap: a reload between the navigation and the session mount loses the first message, because the query cache does not survive a reload. The window is short.

Proof:
- Storybook golden `FirstTurnStreamsLive` (StrictMode): the steps show in this time order without a reload: "Setting up sandbox", "Thinking…", the reasoning, the tool row, the answer. The user message shows once, and exactly one run frame goes on the socket. It was red before the fix and is green after it.
- Storybook golden `FirstTurnFailureRestoresDraft`: an at-capacity `RUN_ERROR` on the first turn shows the error and puts the text back in the composer. It was red without the `draftSeed` change.
- Native contract `conversation-websocket-native.contract.test.ts`: a UI turn on the WebSocket gives turn and chat spans with the conversation's `session.id`, the `user.id`, and the `ui` tag. It was red before `withLangfuseTurnContext`.
- All 12 golden journeys pass.
- Native contract `streams the first turn of a new conversation on the WebSocket, setup first, and stores it` (`workspace-chat-native.contract.test.ts`, `native-chat-websocket-client.ts --new-conversation`): a conversation id with no row gets `RUN_STARTED`, `setup:starting`, `setup:ready`, the text, and `RUN_FINISHED` on the socket, and a fresh process reloads the stored transcript.
- Unit: `start-workspace-conversation-ui.test.ts` proves that the compose step hands off the message and sends no request.

## Follow-ups

- The first message has no idempotency key now. A user retry after a failed first turn sends a new turn. The WebSocket path discards a conversation with no stored turns when the turn fails, as the POST path did.
