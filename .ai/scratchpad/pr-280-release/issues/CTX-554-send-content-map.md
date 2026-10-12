# CTX-554: chat send fails with "undefined is not an object (evaluating 'content.map')"

Status: fixed on `fix/ctx-554-send-content-map` (not pushed).

## Evidence

- HyperDX, `pr-280`, service `backend`: span `chat <model> #0` (the OpenCode adapter call) has status Error with the message `undefined is not an object (evaluating 'content.map')`. Traces `75fd21b195f6cba8e8e129b27263e346`, `89120eeba5eb81eb902b0470d8607d92`, `353c3e4b9030aaef32a4204509b78d7f`. The span fails about 80 ms after it starts, before OpenCode gets a prompt.
- The message is JavaScriptCore wording. The backend runs on Bun, so the throw is on the server. The UI only shows the RUN_ERROR text.
- The exception stack stops at `runTerminalHook` in `@tanstack/ai` chat `index.js`. The original frame is lost. The error log does not record the adapter frame.

## Cause

1. `uiMessagesToWire` (browser) sends an assistant turn without text (a tool call only, or a failed turn) as an AG-UI anchor without `content`. That is valid AG-UI.
2. `convertMessagesToModelMessages` keeps that message as it is, so `content` is `undefined`. The `ModelMessage` type expects `null`.
3. We never pass an OpenCode `sessionId`, so `buildPrompt` in `@tanstack/ai-opencode` flattens each earlier turn. Its `extractText` accepts `null` but not `undefined`, and calls `content.map`.

A conversation that has one such assistant turn fails on each later send.

## Fix

`messagesForOpenCodeChat` (`workspace-chat-opencode-messages.ts`) sets `content: null` on a message that has no `content` and no `parts`. The middleware runs it on the run messages and on the provider messages.

Stored transcripts are not changed by the bug: the browser sends the history each turn. After the fix deploys, affected conversations on pr-280 recover on the next send.

## Tests

- New: `workspace-chat-opencode-messages.test.ts` "gives OpenCode an earlier assistant turn that has no text". It uses the real `uiMessagesToWire`, `chatParamsFromRequestBody`, `convertMessagesToModelMessages`, the middleware, and the real OpenCode `buildPrompt`. It failed before the fix with the same `content.map` throw.
- `workspace-chat-opencode-messages.test.ts` and `workspace-chat-opencode-contract.test.ts`: 26 pass. Biome clean. `test:policy` pass. Backend typecheck has no errors in the touched files (8 errors in other files were present before).

## Follow-up

- Upstream: `extractText` in `@tanstack/ai-opencode` could treat `undefined` like `null`, or `convertOwnMessages` in `@tanstack/ai` could set `null`.
