# ADR-030: Stock TanStack workspace chat

**Status:** Accepted | **Date:** 2026-08-25 | **Tags:** workspace-chat, tanstack, persistence, sandbox

## Context

ADR-029 added a keep-alive OpenCode serve and an attach-only `session.prompt` path because the then-current lock could not pass `baseUrl` into `opencodeText`. That second machine ignored `chat({ messages })`, stored assistant text only, skipped official persistence/durability, and rematerialized the sandbox on prepare (custom clone + serve + session). The lock is now `@tanstack/ai@0.48` + `@tanstack/ai-opencode@0.3.4`.

## Decision

Workspace chat uses the official TanStack loop only:

- `toWebSocketStream({ durability: memoryStream, onRun })`
- `chat({ messages, threadId, runId, middleware: [withPersistence, withSandbox] })`
- `useChat({ persistence: true })` + `GET …/chat` via `reconstructChat`
- Sandbox warm is `definition.ensure()` with the Postgres instance store and lifecycle `{ reuse: "thread", snapshot: "after-setup" }`. Checkout fallback lives in `defineWorkspace` setup, not a second clone API.

Keep outside TanStack: org auth and conversation list metadata.

## Consequences

- ADR-029 is superseded. Attach, in-process conversation runtime, and turn-claim are removed from the product path.
- Reload hydrates thinking/tool/text parts from the message store.
- A warm prepare is `ensure()` resume. First bootstrap may still clone and install OpenCode once.

## Alternatives considered

- Keep attach for serve reuse: rejected; it ignored `ctx.messages` and blocked token streaming.
- Store `parts` jsonb beside a custom persist path: rejected; official `withPersistence` is the store.
