---
name: review-logging-patterns
description: Review or add evlog logging in apps/backend and apps/codesearch (Hono on Bun) and the evlog client in apps/ui. Use when adding logs, replacing `console.*`, or reviewing wide events and structured errors.
license: MIT
metadata:
  forkedFrom: hugorcd/evlog
---

# Review logging patterns

Backend and codesearch log with evlog on Hono (Bun). The UI browser logger is `evlog/client`. One wide event per request or job.

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

Both apps register one `evlog()` middleware from `evlog/hono`.

- Backend: [`apps/backend/src/app/app.ts`](../../../apps/backend/src/app/app.ts) calls `evlog()` with no drain. The drain is `initLogger`.
- Codesearch: [`apps/codesearch/src/app/app.ts`](../../../apps/codesearch/src/app/app.ts) passes `createEvlogDrain()` and runs `applyCodesearchLogContract` in `enrich`.

## Drain

Backend `initLogger({ silent, redact, drain })` in [`logger.ts`](../../../apps/backend/src/observability/logger.ts) is the only backend drain. The drain calls `applyLogContract`, writes JSON to stdout in production, and sends OTLP with `createOTLPDrain` from `evlog/otlp` (5 s timeout, no retry). `flushEvlog()` awaits in-flight sends.

Codesearch wraps `createOTLPDrain` in `createDrainPipeline` (batch 50 / 5 s, 3 retries, then `onDropped`). `flushEvlog()` calls `drain.flush()`.

Unset `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` → stdout only.

## Log contract

- Backend: `applyLogContract` in [`logContract.ts`](../../../apps/backend/src/observability/logContract.ts), called from the `initLogger` drain.
- Codesearch: `applyCodesearchLogContract` in [`logger.ts`](../../../apps/codesearch/src/observability/logger.ts), called from the Hono `enrich`.

The contract strips email, name, and IP, copies the active span onto `traceId` / `spanId`, and aliases HTTP and org fields onto the canonical keys. Those keys live in [ADR-011](../../../.ai/memory/decisions/ADR-011-backend-observability-otel.md). Put ids on the event; leave the key list to that ADR.

## Wide events

Accumulate on the request logger with `getLogger().set({ step, … })`. evlog emits one event when the request ends. Failures: `getLogger().error(err, { step })`. A query, cache hit, or retry count is a field on the parent event.

`withLogger` stores a `createLogger` in AsyncLocalStorage and calls `emit()` in `finally`. A long codesearch index phase calls `flushWorkflowLog()` after a milestone so the event leaves before the HTTP handler returns. After emit, the helper rotates a fresh logger with the same base context.

## Structured errors

Throw `createError` from `evlog` when the caller needs what failed, why, and the HTTP status. The backend `onError` logs the error and returns `parseError` (`message`, `why`, `fix`, `link`). Shape: [references/structured-errors.md](references/structured-errors.md).

## Review

On a backend or codesearch diff:

1. New logs call `getLogger()` or `log` from `src/observability/logger.ts`.
2. A request handler accumulates with `set` on the request logger and emits once (the middleware emits).
3. Failures use `getLogger().error(err, { step })` or `log.error(err, { step })`, with the original error as `cause` when rethrown via `createError`.
4. Logs leave through `initLogger` in `observability/logger.ts`. One `evlog()` middleware per app.
5. Events carry ids. Email, name, IP, tokens, and query strings are absent. Keys match [ADR-011](../../../.ai/memory/decisions/ADR-011-backend-observability-otel.md).
6. A UI change that logs in the browser goes through `evlog/client` (`useAuthEvlogIdentity`), not `console`.
