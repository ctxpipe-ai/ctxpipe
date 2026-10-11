# Workspace chat turn over the WebSocket has no request span and no trace that joins its model calls

Status: ready-for-human
Priority: P1
Owner: agent (obs-llm-traces)
Blocked by: none
Created: 2026-10-11
Updated: 2026-10-11

## Context

The UI sends a chat turn over the conversation WebSocket. Ticket 37 sent one turn that used tools (conversation `conv_0564162ac1153f4e3336619476b5f981`, sent 2026-10-11 01:17:54 UTC, answer at about 01:18:30 UTC, preview `pr-280`).

## Evidence

- No backend server span, no `request.id`, and no wide-event log for the turn itself. The browser network log shows no HTTP request for the send; the turn goes over the socket.
- The six model calls from the sandbox each made their own trace: `cad42b8c20a845ca8fd2b5ca8bec2c36`, `f6a8d4f8c33b11014a85b4c0083aa14d`, `40f5c9456f4ec81dab7537b52b2765dd`, `8bedcb08cd91f1dde0b29ceee3f3111f`, `0d9dd1f7067fc0aef3592fa7469e8d3b`, `f429f31cf1133a3f8b6a08a57852eaf0` (`POST /:orgSlug/api/v1/workspace-chat/openai/v1/chat/completions` with a `generation #N` child).
- The TanStack turn span `chat ctxpipe/openai/gpt-5.6-terra` (31.2 s) is a separate root trace, `a556044174efe5cf73a5df98f4fc44ff`. It has no org attributes.
- The MCP path is correct, for comparison: `ctx_advisor` trace `0ae4180de87efbe8a934fceebcc1b5b8` holds `POST /mcp`, `mcp.tool ctx_advisor`, `workspace-chat.turn`, and the chat span in one trace.
- Server-side code: `apps/backend/src/routes/v1/conversation-websocket.ts` has no span and no attribution. Its only telemetry is one `log.error`. `apps/backend/src/server.ts` routes the socket before Hono, so `backendOtelMiddleware` never runs.
- `apps/backend/src/domain/workspaces/workspace-chat-otel.ts` starts `workspace-chat.turn`, `generation #N`, and `tool <name>` with `tracer().startSpan(...)` and no parent context. Each span joins whatever context is active at that time (the proxy request), not the turn.

## Expected vs actual

- Expected: one trace per turn. A root span (for example `workspace-chat.turn`) carries `ctxpipe.org.*`, `enduser.id`, `ctxpipe.conversation.id`, and a request or run id. Each generation and tool span is a child of it. A log line of the turn carries that `traceId`.
- Actual: no root for the UI path; one trace per model call; the turn span floats alone.

## Scope

- Open a span with attribution when the socket receives a turn (or when the run starts). Use the same attribution helpers as HTTP (`observability/attribution.ts`).
- Pass the turn span context as the parent to the generation and tool spans in `workspace-chat-otel.ts` (`trace.setSpan(context.active(), state.rootSpan)`), so they join the turn even when the proxy request is the active context. Keep the proxy server span linked (a span link is enough).
- Test with the OTel in-memory exporter: a turn with two generations and one tool gives one trace id.

## Acceptance criteria

- [ ] A UI chat turn on a preview gives one HyperDX trace with the turn root, all generations, and the tools.
- [ ] The root carries org, user, and conversation ids.

## Comments

## Resolution

Cause: the socket turn ran with no attribution context, and `workspace-chat-otel.ts` started the turn, generation, and tool spans with no explicit parent. Each span joined the context that was active at that time: the proxy request for a generation, nothing for a tool, and nothing for the TanStack chat span.

Fix (branch `obs-llm-traces`):

- `beginWorkspaceChatTurn` now takes the org, org slug, and Workspace. It makes a new attribution bag from the active attribution plus those ids and the conversation id, starts `workspace-chat.turn` in that context, and returns the turn context. A turn with no caller span (the socket) sets `langfuse.trace.name=workspace-chat`.
- Generation and tool spans start with the turn context as parent. A generation span has a link to the proxy server span.
- `streamTanstackWorkspaceChat` runs each step of its body in the turn context (`iterateInWorkspaceChatTurn`), so the TanStack `chat <model>` span is a child of the turn.
- The turn summary log line is written in the turn context, so it has the turn `traceId`.
- `conversation-websocket.ts` (`withSocketTurnContext`) gives each socket step an attribution bag with `enduser.id`, `ctxpipe.actor.type=user`, the org id and slug, and the conversation id. This also gives the Langfuse turn context its `org:` tag (ticket 44).

Tests: `workspace-chat-otel.test.ts` ("joins the generations, the tools, and the TanStack chat span under one attributed turn root") asserts one trace id, the parent of each child, the root attributes, and the proxy link with `InMemorySpanExporter`. `conversation-websocket.attribution.test.ts` asserts the socket attribution and the Langfuse `org:` tag.

To prove after a deploy: send a UI chat turn with tools on the preview and open the trace in HyperDX. Expect one trace with `workspace-chat.turn` as root, the `chat <model>` span, each `generation #N`, and each `tool <name>` under it.

