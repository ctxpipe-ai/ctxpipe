# OTLP drain

Both services share one drain: `createEvlogDrain()` in `src/observability/logger.ts`. It is the production path. Do not add a second pipeline or another adapter.

## When it runs

`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` set: batch, retry, POST `{base}/v1/logs`. evlog appends `/v1/logs`, so the helper strips a trailing `/v1/logs` from the env value first. Headers come from `OTEL_EXPORTER_OTLP_HEADERS`.

Unset: `createEvlogDrain()` returns `undefined`. evlog writes stdout. `initLogger` uses `pretty` when `NODE_ENV` is `development`.

## Pipeline

```typescript
createDrainPipeline<DrainContext>({
  batch: { size: 50, intervalMs: 5000 },
  retry: { maxAttempts: 3, backoff: "exponential", initialDelayMs: 1000 },
  onDropped: (events, error) => {
    log.error({
      step: "evlog.pipeline",
      droppedEventCount: events.length,
      message: `[evlog] Dropped ${events.length} events`,
      error: error instanceof Error ? error.message : undefined,
    })
  },
})
```

The inner function maps each event with `toOTLPLogRecord` (`evlog/otlp`), then `canonicalizeOtlpLogRecord`, and `fetch`es with `AbortSignal.timeout(5_000)`. A timeout or a down collector throws; the pipeline retries, then `onDropped`. The request and shutdown still succeed.

`flushEvlog()` calls `drain.flush()` and then clears the cached drain. Call it on server shutdown so a partial batch is not lost.
