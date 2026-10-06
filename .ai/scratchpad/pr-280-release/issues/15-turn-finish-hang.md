# A chat turn can send its final message but never finish

Status: in-review
Priority: P1
Owner: unassigned
Blocked by: none
Created: 2026-10-06
Updated: 2026-10-06

## Context

Sometimes a hosted chat turn streams the full assistant text but never sends `RUN_FINISHED`. The HTTP body then stays open. In the contract tests the turn times out at 150 s (`sandbox-lifecycle-native.contract.test.ts` "a chat not driven from the UI stops its sandbox when it finishes", and sometimes `conversation-branch-push-native.contract.test.ts`). It also happens at the PR head with no other change. A user sees a turn that does not end.

## Cause (most likely, checked in the code)

The TanStack chat engine sends text chunks at once, but it holds `RUN_FINISHED` until the adapter's `chatStream` generator returns (`@tanstack/ai` `activities/chat/index.js`: deferred run-finished chunks, flushed after the stream loop). The `@tanstack/ai-opencode` adapter (`adapters/text.js`, the `finally` block) awaits `handle.dispose()`, `server.dispose()` (`proc.kill()`, an awaited `docker exec`), and `bridge.close()` in sequence before it returns. `bridge.close()` waits for `httpServer.close()`, and that waits for MCP keep-alive sockets. If one of these steps does not settle, `RUN_FINISHED` is never sent. Our patch bounds only the SSE `stream.return` to 1 s.

The orphan `opencode serve` processes have a second cause. The local-process sandbox starts each command in its own process group (`detached: true`), so that `killTree` can stop the full tree. When the owner process (vitest or the backend) dies, or a test times out and abandons the stream, no teardown runs and no signal reaches the group. Thus the server continues to run. On the development machine, 77 orphan `opencode serve` processes ran. I killed the 75 that were older than 1 hour with a plain `SIGTERM`, and each one stopped. Thus "the process ignores `SIGTERM`" did not make them.

A reused Docker or Vercel sandbox can also leak a server. Chat sandboxes use `reuse: "thread"` and `destroyOnComplete: false`. When the backend dies during a turn, the `opencode serve` in the sandbox continues to run and holds port 4096. The next turn in the same sandbox then cannot bind the port.

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
- 2026-10-06 (claude): A second trace found that `await bridge.close()` did not return, and that the `opencode serve` process was still alive. 77 orphan `opencode serve` processes from earlier test runs ran with parent 1 on the development machine.

## Resolution

The original hang was not reproduced (see Reproduction). The tests below reproduce its shape: a server that does not stop, and a tool bridge that does not close.

Our code does the process cleanup. One vendor hunk stays, because our code cannot change when the engine sends `RUN_FINISHED`.

1. Kill escalation, our code ([`sandbox-lifecycle-timing.ts`](../../../../apps/backend/src/domain/workspaces/sandbox-lifecycle-timing.ts)). The `kill` of each spawned process in the timed sandbox wrapper passes its signal on. With no signal, it sends the default kill, waits up to 500 ms for `wait()`, and then sends `SIGKILL`. This applies to each provider.
2. Owner watchdog, our code ([`sandbox-process-guards.ts`](../../../../apps/backend/src/domain/workspaces/sandbox-process-guards.ts) `withOwnerWatchdog`, on the unsandboxed provider). Each spawn registers its process group with one watchdog `sh` per owner process. The watchdog reads a stdin pipe that only the owner holds. When the owner dies, the pipe closes, and the watchdog sends `SIGKILL` to each group that is still registered. When the watchdog itself dies, the next spawn starts a new one that also watches the groups that still run. This works on macOS and Linux and does not poll. Known limits: the wrapper removes a group from the watchdog when the group leader exits. Thus when the leader exits but a grandchild stays in the group, the watchdog does not stop that grandchild. A process that leaves its group (for example with `setsid`) is also not stopped.
3. One server per reused sandbox, our code (`withSingleOpencodeServer`, on the Docker and Vercel providers). Before `opencode serve` starts, the wrapper sends `SIGKILL` to an earlier `opencode serve` in the sandbox (found through `/proc`), and waits up to 5 s until it is gone. One conversation owns each such sandbox, and the sandbox lock allows one turn at a time. The wrapper is not on the unsandboxed provider, because there the host is shared.
4. The vendor hunk ([`patches/@tanstack__ai-opencode@0.4.14.patch`](../../../../patches/@tanstack__ai-opencode@0.4.14.patch), `adapters/text.js`): the adapter `finally` block gives each teardown step (session dispose, server dispose, tool bridge close) at most 1 s. A failed step goes to the adapter logger. The user accepted this hunk on 2026-10-06 ([ADR-044](../../../memory/decisions/ADR-044-workspace-chat-stock-tanstack.md)). Upstream issue: to be opened.

Removed from the first fix:

- The `@tanstack/ai-sandbox-local-process` patch: the owner watchdog is now our code (item 2).
- The `sandbox-server.js` dispose hunk: the kill escalation is now our code (item 1).
- The abort hunk (an abort fails the queue): it made each user stop a synthetic `RUN_ERROR` that is logged as fatal. No test showed a failure that it fixes.
- The "event stream ended before dispose" throw: no test showed a failure that it fixes.

Not done, with the reasons:

- `closeAllConnections()` on the tool bridge: the bridge `httpServer` is in `@tanstack/ai-sandbox`, which has no patch. When the server process stops, its sockets close, and `httpServer.close()` completes.
- "Create the waiter before the second `terminal` check": `terminal.has()` and `terminalWaiters.set()` run in one synchronous step. No event can arrive between them.

### Reproduction

I did not see the hang on this branch head: the prepare test passed 5 times out of 5 before the fix. A real `opencode serve` (1.18.34) stopped within 10 ms of `SIGTERM` in three probes: idle, with a session, and with an open `/event` stream. Thus the exact trigger is not known. The tests reproduce the shape of the failure deterministically; they do not reproduce the original hang.

### Proof

New tests, each through our product provider (`conversationSandboxProvider` in `timedSandboxProvider`):

- `finishes a turn and stops its OpenCode server when the server ignores SIGTERM and holds the tool bridge open` ([`workspace-chat-opencode-native.contract.test.ts`](../../../../apps/backend/src/domain/workspaces/workspace-chat-opencode-native.contract.test.ts)). A fake `opencode` on `PATH` ignores `SIGTERM` and keeps a request open on the tool bridge. The test asserts `RUN_FINISHED` less than 5 s after the last text, no `RUN_ERROR`, and that the process stopped. Without the kill escalation: it failed (the process still ran).
- `finishes a turn when the sandbox never settles the OpenCode server kill` (same file). A test wrapper makes `kill` never settle. The test asserts `RUN_FINISHED` less than 5 s after the last text. Without the vendor hunk: it failed (no `RUN_FINISHED` in 10 s).
- `stops the unsandboxed OpenCode servers when the process that started them dies, also after its watchdog died` (same file). A real child process starts a server, the test kills the watchdog, the child starts a second server, and the test kills the child with `SIGKILL`. Both servers must stop within 5 s. Without the watchdog reset: it failed (both servers still ran).
- `starts the agent server in a reused Docker sandbox after a dead backend left its server running` ([`docker-agent-port-native.contract.test.ts`](../../../../apps/backend/src/domain/workspaces/docker-agent-port-native.contract.test.ts)). It starts a server, abandons it, resumes the sandbox from its id, and starts a server again. Without the stop: it failed (`opencode serve exited before becoming ready`).

Five runs in a row of each target, one run at a time (2026-10-06):

- The four new tests: 5 of 5 passed.
- `workspace-chat-prepare-native.contract.test.ts` "retains recoverable edits" (2 cases): 5 of 5 passed.
- `conversation-publish-native.contract.test.ts` (8 tests): 5 of 5 passed.
- `workspace-chat-native.contract.test.ts` cancellation ("releases native transcript ownership after cancellation", "active disconnect: true"): 5 of 5 passed.
- `sandbox-lifecycle-native.contract.test.ts`: 8 of 11 passed in each run. The same 3 sweep tests fail at the base commit with no change from this ticket: the sweep counts rows that other runs left in the shared local database (`deleted: 4`, expected 0), and the org slot limit is full. This is not caused by this ticket.
- `opencode serve` processes: 1 before all runs and 1 after (not from these runs).

### Upstream issue draft (TanStack/ai; to be opened by the coordinator)

**Title:** `ai-opencode`: `RUN_FINISHED` never arrives when an adapter teardown step does not settle

**Body:**

> `chat()` holds `RUN_FINISHED` until the adapter's `chatStream` generator returns. In `@tanstack/ai-opencode` 0.4.14, the `finally` block of `OpencodeTextAdapter.chatStream` awaits `handle.dispose()`, `server.dispose()`, and `bridge.close()` in sequence. If one of them does not settle, the text streams but the run never ends, and the HTTP response stays open.
>
> **Repro**
>
> 1. Run `chat()` with `opencodeText(...)`, `withSandbox(...)`, and at least one tool, so that a tool bridge opens.
> 2. Wrap the sandbox provider so that `process.kill()` on a spawned process returns a promise that never settles (as a sandbox API call that never returns does). Or use an `opencode` on `PATH` that ignores `SIGTERM` and keeps a request open on the tool bridge.
> 3. Observe: `TEXT_MESSAGE_END` arrives, but `RUN_FINISHED` does not.
>
> **Proposed fix**
>
> Give each teardown step a time limit, and log a step that fails:
>
> ```js
> const bounded = (step) => Promise.race([
>   Promise.resolve().then(step).catch((error) => logger.errors("opencode teardown failed", { error, source: "opencode.chatStream" })),
>   new Promise((resolve) => setTimeout(resolve, 1000).unref()),
> ])
> await bounded(() => handle?.dispose())
> await bounded(() => server?.dispose())
> await bounded(() => bridge?.close())
> ```
>
> **Suggestion (separate, `@tanstack/ai-sandbox-local-process`)**
>
> `spawn` uses `detached: true`, so a spawned process group gets no signal when its owner process dies, and the server continues to run with parent 1. One option: start one watchdog per owner with a stdin pipe that only the owner holds, register each spawned group with it, and kill the registered groups when the pipe closes.
