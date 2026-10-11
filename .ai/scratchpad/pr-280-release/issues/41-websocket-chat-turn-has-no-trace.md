# Workspace chat turn over the WebSocket has no request span and no trace that joins its model calls

Status: ready-for-agent
Priority: P1
Owner: unassigned
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
