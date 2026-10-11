# False error spans and streaming server spans that end too early

Status: ready-for-agent
Priority: P3
Owner: unassigned
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
