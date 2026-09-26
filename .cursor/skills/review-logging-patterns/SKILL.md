---
name: review-logging-patterns
description: Review or add evlog logging in apps/backend and apps/codesearch (Hono on Bun) and the evlog client in apps/ui. Use when adding logs, replacing `console.*`, or reviewing wide events and structured errors.
license: MIT
metadata:
  forkedFrom: hugorcd/evlog
---

# Review logging patterns

Backend and codesearch log with evlog on Hono (Bun). The UI browser logger is `evlog/client`. One wide event per request or job. Logs leave through the OTLP drain in `observability/logger.ts`.

## When to use

- Adding a log in `apps/backend` or `apps/codesearch`
- Replacing `console.*` with evlog
- Reviewing a wide event, a structured error, or the drain

App-local rules: [apps/backend/AGENTS.md](../../../apps/backend/AGENTS.md) (Logging), [apps/codesearch/AGENTS.md](../../../apps/codesearch/AGENTS.md) (Logging).

## Which logger

| Context | Call |
| --- | --- |
| Hono handler or middleware | `getLogger()` from `src/observability/logger.ts` (same logger as `c.var.log`) |
| Workflow or graph node inside `withLogger` | `getLogger()` |
| Domain helper, DB hook, or bootstrap with no request | `log` from the same module (`log.info` / `log.error` emit immediately) |
| Long job that must flush before return | `createLogger` + `withLogger`; codesearch index phases call `flushWorkflowLog()` |
| Browser | `setIdentity` / `clearIdentity` from `evlog/client` in [`useAuthEvlogIdentity.ts`](../../../apps/ui/src/lib/useAuthEvlogIdentity.ts) |

`getLogger()` throws when neither Hono context nor AsyncLocalStorage has a logger. A script that skips `server.ts` calls `initEvlog()` once at entry.

## Hono setup

Both apps register one `evlog()` middleware from `evlog/hono`. Copy that shape.

Backend: [`apps/backend/src/app/app.ts`](../../../apps/backend/src/app/app.ts)

```typescript
app.use(
  evlog({
    drain: createEvlogDrain(),
    enrich: (ctx) => {
      applyLogContract(ctx.event as Record<string, unknown>)
    },
  }),
)
```

Codesearch: [`apps/codesearch/src/app/app.ts`](../../../apps/codesearch/src/app/app.ts) — same `drain`; `enrich` calls `applyCodesearchLogContract`.

`initLogger` in `observability/logger.ts` passes the same drain for non-HTTP `log` calls.

## Drain

`createEvlogDrain()` is the only drain. It builds the OTLP body with `toOTLPLogRecord` from `evlog/otlp` and batches with `createDrainPipeline` from `evlog/pipeline`. When `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` is unset, the drain is `undefined` and evlog writes stdout. A failed export retries, then drops; it does not fail the request. Call `flushEvlog()` on shutdown. Pipeline: [references/drain-pipeline.md](references/drain-pipeline.md).

## Log contract

`enrich` runs before the drain:

- Backend: `applyLogContract` in [`logContract.ts`](../../../apps/backend/src/observability/logContract.ts)
- Codesearch: `applyCodesearchLogContract` in [`logger.ts`](../../../apps/codesearch/src/observability/logger.ts)

The contract strips email, name, and IP, copies the active span onto `traceId` / `spanId`, and aliases HTTP and org fields onto the canonical keys. Those keys live in [ADR-011](../../../.ai/memory/decisions/ADR-011-backend-observability-otel.md) (decision 6, Attribution). Put ids on the event; leave the key list to that ADR.

## Wide events

Accumulate on the request logger with `getLogger().set({ step, … })`. evlog emits one event when the request ends. Failures: `getLogger().error(err, { step })`. A query or cache hit belongs on the parent event. Patterns: [references/wide-events.md](references/wide-events.md).

## Structured errors

Throw `createError` from `evlog` when the caller needs what failed, why, and the HTTP status. The backend `onError` logs the error and returns `parseError` (`message`, `why`, `fix`, `link`). Shape: [references/structured-errors.md](references/structured-errors.md).

## Anti-patterns

- Application logs go through `getLogger()` or `log`.
- Logs leave through `createEvlogDrain()` only.
- Events carry ids. The contract removes email, name, and IP.
- Checklist: [references/code-review.md](references/code-review.md).
