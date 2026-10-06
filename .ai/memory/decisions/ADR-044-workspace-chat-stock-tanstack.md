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
- One patch remains, on `@tanstack/ai-opencode` 0.4.14. It has two parts:
  - Ticket 01 scope (`process/server.js`, `stream/translate.js`): it classifies streamed parts by message role, waits for the event stream before prompting and for the assistant's final update before finishing, and bounds dispose. It is accepted until an upstream PR merges, raised after the production launch.
  - Ticket 15 scope (`adapters/text.js`, one hunk): the adapter `finally` block gives each teardown step (session dispose, server dispose, tool bridge close) at most 1 s, and logs a step that fails. The engine holds `RUN_FINISHED` until this generator returns, so our code cannot do this. The user accepted this hunk on 2026-10-06, as this ADR requires. Upstream issue: https://github.com/TanStack/ai/issues/1638.
- Process cleanup for chat sandboxes is our code, not a patch: a kill escalation to `SIGKILL` in the timed sandbox wrapper, an owner watchdog for unsandboxed (local-process) sandboxes, and a stop of an earlier `opencode serve` before a new one starts in a reused Docker or Vercel sandbox (ticket 15).

## Alternatives considered

- Keep attach / keep-alive serve: rejected; it ignored `ctx.messages` and blocked streaming.
- A custom `parts` store beside persistence: rejected; `withPersistence` is the store.
