# ADR-044: Stock TanStack workspace chat

**Status:** Accepted (revised 2026-10-02) | **Date:** 2026-08-25 | **Tags:** workspace-chat, tanstack, persistence, sandbox

## Context

Workspace chat runs OpenCode inside a per-conversation sandbox. A homemade attach/keep-alive path ([ADR-043](ADR-043-workspace-chat-keep-alive-serve.md)) bypassed TanStack's persistence and stream lifecycle and was replaced. During PR 280 recovery the stack accumulated ~9.9k lines of `pnpm patch` against `@tanstack/ai*` and `@opencode-ai/sdk`.

## Decision

- Chat uses the official TanStack loop only: `useChat({ persistence: true })` ↔ `toWebSocketStream({ durability: memoryStream })` ↔ `chat({ messages, threadId, runId, middleware: [withPersistence, withSandbox] })` with `opencodeText`. Reload hydrates through `reconstructChat` (`GET …/chat`).
- Transcripts are TanStack persistence over Postgres; `threadId` is the conversation id. The app owns only org auth, conversation list metadata, retrieval tools, and credential brokering.
- Sandbox warm-up is `definition.ensure()` against the Postgres instance store ([ADR-048](ADR-048-native-postgres-sandbox-ownership.md)).
- **TanStack stays stock.** Patches are debt to remove by upgrading and by changing our design; any patch that cannot go needs an upstream PR and explicit acceptance (PR 280 ticket 01).
- Models are only the configured fast/medium/high tiers through the app's model proxy ([workspace-chat-models](../PRDs/workspace-chat-models.md)).

## Consequences

- Persistence, streaming and resume behave as upstream documents; fixes go upstream or into our wiring, not into vendored package code.
- A turn lives longer than its socket. `toWebSocketStream` stops each turn of a closed socket, so our wiring keeps the close from it until the turn has closed its run log. Only an abort frame (the Stop control) stops a turn, from any socket of the same user in the same conversation. The question and a running run record are stored before the sandbox setup, so a reload attaches to the turn or shows its answer.
- One patch remains, on `@tanstack/ai-opencode` 0.4.14. It has three parts:
  - Ticket 01 scope (`process/server.js`, `stream/translate.js`): it classifies streamed parts by message role, waits for the event stream before prompting, and bounds dispose. It resolves a prompt at the session idle event that comes after the terminal update of the reply (the update with a completion time or an error). This is from CTX-1061. OpenCode 1.18 serializes a `message.updated` event when it writes the event to the stream. On a slow stream, the first update of the reply can thus show the reply as finished before the stream sends the text. OpenCode sends the idle event after all events of the run. An error or an abort can set the session idle before the terminal update, and OpenCode sets the session idle again when the run stops. Thus the prompt resolves at that second idle event. This hunk is accepted until an upstream PR merges, raised after the production launch. The CTX-1061 change to the hunk is part of that upstream PR (pending), and its acceptance is pending review in PR #536.
  - Ticket 15 scope (`adapters/text.js`, one hunk): the adapter `finally` block gives each teardown step (session dispose, server dispose, tool bridge close) at most 1 s, and logs a step that fails. The engine holds `RUN_FINISHED` until this generator returns, so our code cannot do this. The user accepted this hunk on 2026-10-06, as this ADR requires. Upstream issue: https://github.com/TanStack/ai/issues/1638.
  - Permission scope (`process/server.js`): OpenCode 1.x sends a permission ask as `permission.asked` and takes the answer at `POST /permission/{requestID}/reply`. The adapter answers only the older `permission.updated`. The patch sends the new ask to the same permission handler, with the permission name as `type` and the patterns and metadata of the ask, and posts the answer to the new route. The older event works as before. Without this part, the chat permission handler (hard denies, `acceptEdits`, the judge) never runs, and each ask holds the turn until it is cancelled. The user must accept this hunk, as this ADR requires; it waits for a security review. Upstream issue: to be opened.
- Process cleanup for chat sandboxes is our code, not a patch: a kill escalation to `SIGKILL` in the timed sandbox wrapper, an owner watchdog for unsandboxed (local-process) sandboxes, and a stop of an earlier `opencode serve` before a new one starts in a reused Docker or Vercel sandbox (ticket 15).

## Alternatives considered

- Keep attach / keep-alive serve: rejected; it ignored `ctx.messages` and blocked streaming.
- A custom `parts` store beside persistence: rejected; `withPersistence` is the store.
