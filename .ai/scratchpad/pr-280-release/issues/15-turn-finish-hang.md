# A chat turn can send its final message but never finish

Status: plan-review
Priority: P1
Owner: unassigned
Blocked by: none
Created: 2026-10-06
Updated: 2026-10-06

## Context

Sometimes a hosted chat turn streams the full assistant text but never sends `RUN_FINISHED`. The HTTP body then stays open. In the contract tests the turn times out at 150 s (`sandbox-lifecycle-native.contract.test.ts` "a chat not driven from the UI stops its sandbox when it finishes", and sometimes `conversation-branch-push-native.contract.test.ts`). It also happens at the PR head with no other change. A user sees a turn that does not end.

## Cause (most likely, checked in the code)

The TanStack chat engine sends text chunks at once, but it holds `RUN_FINISHED` until the adapter's `chatStream` generator returns (`@tanstack/ai` `activities/chat/index.js`: deferred run-finished chunks, flushed after the stream loop). The `@tanstack/ai-opencode` adapter (`adapters/text.js`, the `finally` block) awaits `handle.dispose()`, `server.dispose()` (`proc.kill()`, an awaited `docker exec`), and `bridge.close()` in sequence before it returns. `bridge.close()` waits for `httpServer.close()`, and that waits for MCP keep-alive sockets. If one of these steps does not settle, `RUN_FINISHED` is never sent. Our patch bounds only the SSE `stream.return` to 1 s.

Other possible causes:
- `session.prompt()` never settles: abort and an SSE end without an error do not fail the queue.
- A terminal event is lost between `terminal.has` and `terminalWaiters.set`.

## Plan

1. Write a deterministic test with no model and no Docker. Run `chat()` with `opencodeText` against a loopback OpenCode fake, with a sandbox double whose `kill()` never resolves while a tool-bridge socket stays open. Assert that `RUN_FINISHED` arrives within 2 s. It fails today.
2. Extend the existing `patches/@tanstack__ai-opencode@0.4.14.patch` by about 15 lines:
   - Limit each teardown step to about 1 s.
   - Close the bridge with `closeAllConnections()`.
   - When the run aborts or the SSE stream ends without a terminal event, fail the queue.
   - Create the waiter before the second `terminal` check.
3. Open an upstream issue or PR on TanStack AI, so that the patch can go after launch (the patch policy allows temporary patches for provider gaps).
4. Run the lifecycle and branch-push contract files 5 times in a row. They must pass every time.

## Rejected

- A fix in our code only: the engine holds `RUN_FINISHED` until the adapter generator returns, so our code cannot see it or send it early.

## Comments

- 2026-10-06 (claude): A Grok investigation found the cause. I checked the `finally` block in `adapters/text.js` myself.

## Resolution
