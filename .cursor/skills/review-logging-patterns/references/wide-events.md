# Wide events

One event per HTTP request or job. The Hono middleware emits it when the handler returns. Add context on that logger; do not open a second logger for the same request.

## Request

```typescript
const log = getLogger()
log.set({ step: "ingest.resolve_ref" })
log.error(err, { step: "ingest.resolve_ref" })
```

HTTP method, path, and status are the middleware's fields. The log contract aliases them. Set `step` and the ids for this operation. Canonical attribute keys: [ADR-011](../../../../.ai/memory/decisions/ADR-011-backend-observability-otel.md) decision 6.

## Job

`withLogger` stores a `createLogger` in AsyncLocalStorage and calls `emit()` in `finally`. A long codesearch index phase calls `flushWorkflowLog()` after a milestone so the event leaves before the HTTP handler returns. After emit, the helper rotates a fresh logger with the same base context.

## What stays off its own line

A query, cache hit, or retry count is a field on the parent event. A new wide event is a new request or a new job, not a step inside one.
