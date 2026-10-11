# False error spans and streaming server spans that end too early

Status: ready-for-human
Priority: P3
Owner: agent (obs-llm-traces)
Blocked by: none
Created: 2026-10-11
Updated: 2026-10-11

## Context

Error counts on the ctxpipe Services dashboard and HyperDX alerts use `StatusCode='Error'`. Some spans are errors when nothing failed. Some server spans end at the response headers of a stream.

## Evidence

`pr-280`, 2026-10-11:

- MCP `ctx_advisor` call (trace `0ae4180de87efbe8a934fceebcc1b5b8`, `x-request-id` `t37-mcp-advisor`, 01:23:35 UTC, HTTP 200): two better-auth spans `GET /get-session` and two `hook before /get-session plugin:api-key` are `Error` on an API-key request that succeeded.
- Workspace hydrate (trace `ceb1f92afc6090d45414c6bb83458856`, 01:15:04 UTC): five FalkorDB spans `CREATE WorkspaceKnowledgeUnit` are `Error` with "Attribute 'projectionKey' is already indexed", which is the normal case of an index that already exists.
- The same `POST /mcp` server span lasts 0.1 s, while the tool call took 27 s (the response streams; the server span ends at the headers). The work spans run to 01:24:02. The chat conversation POST had the same shape in earlier tickets.
- Backend 4xx server spans (for example the 404 in trace `abac40316dabf8e41725068ac616f261`) are `Unset`. That is correct OTel practice and is noted here only to keep it so.

Likely cause: better-auth's own OTel instrumentation marks the session lookup as an error when no session cookie is present; `ensureIndex` code around FalkorDB (search `apps/backend/src` for `projectionKey`) records the expected error; `@hono/otel` ends the span when the handler returns a stream.

## Expected vs actual

- Expected: `Error` only on a real failure; a streamed response's server span (or a child span) covers the stream.
- Actual: false errors; misleading durations.

## Scope

- Ignore "already indexed" in the index helper (do not record it as an error).
- Set the better-auth session spans to `Unset` for an API-key actor, or drop that instrumentation if it adds nothing.
- End the server span (or add a `stream` child span) when a streamed body finishes.

## Acceptance criteria

- [ ] A successful MCP call and a hydrate run produce no `Error` spans.
- [ ] A streamed MCP response's trace shows the real duration on a span under the server span.

## Comments

## Resolution

Cause:

- better-auth records each thrown `APIError` (its HTTP answer, for example no session on an API-key request) as a span error, and `BetterAuthSpanFilter` kept every error span.
- `traceGraphQuery` recorded the FalkorDB "already indexed" answer as an error, although the caller ignores it (FalkorDB has no `CREATE INDEX IF NOT EXISTS`).
- `@hono/otel` ends the server span when the handler returns, which is at the headers of a streamed answer.
- A failed chat turn set `error.type` on `workspace-chat.turn` but no error status.

Fix (branch `obs-llm-traces`):

- `BetterAuthSpanFilter` also drops a better-auth span whose exception is an `APIError`. It keeps other failures (for example an adapter error). The server span keeps the HTTP status.
- `traceGraphQuery` does not record an error for "already indexed" on a `CREATE INDEX` query.
- `backendOtelMiddleware` adds a child span `http.response.stream` to a `text/event-stream` answer. The span ends at the last chunk, has error status when the stream fails, and has `http.response.stream.cancelled=true` when the client leaves. The server span stays as `@hono/otel` makes it.
- A failed turn root has error status.
- 4xx server spans stay `Unset`.

Tests (each failed before the fix): `betterAuthSpanFilter.test.ts`, `dbTrace.test.ts` ("does not mark an index that already exists as an error"), `http.test.ts` ("covers a streamed response with a child span that ends with the stream", and no stream span on JSON), `workspace-chat-otel.test.ts` ("gives a failed turn error status").

To prove after a deploy: a successful MCP `ctx_advisor` call and a hydrate run have no `Error` spans, and the MCP trace has `http.response.stream` under `POST /mcp` with the duration of the tool call.

