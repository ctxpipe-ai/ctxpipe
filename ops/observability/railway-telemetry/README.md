# railway-telemetry

Five-minute cron (`cron_schedule` in Terraform). Restart policy NEVER is a one-time Railway dashboard setting. One run reads Railway GraphQL and posts OTLP/JSON with the original timestamps.

The window is the last 6 closed minutes: the 5-minute interval plus one minute of slack. The open minute is excluded. Samples are deduped inside the run.

Metrics: observability `production`, product `production`, and product `pr-*`. Logs: observability `production` only (cap 5000). Severity is set only when Railway's value is not `info`, so the collector `transform` on `logs/out-default` can infer the rest.

Required env: `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `RAILWAY_API_TOKEN`, `RAILWAY_PROJECT_ID` (Railway injects this).

Tests: `pnpm --filter railway-telemetry test`.
