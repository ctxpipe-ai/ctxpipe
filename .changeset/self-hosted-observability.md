---
"@ctxpipe/aws-cdk": minor
---

Report complete, attributed telemetry to any OTLP collector: backend HTTP server spans that continue browser `traceparent`, `x-request-id` on every response, user/org/actor ids on spans, logs, jobs, and Langfuse traces, codesearch traces and metrics, Bun-safe runtime metrics, `gen_ai.*` attributes on LangChain calls, and richer `@hyperdx/browser` reporting (page views, web vitals, identity) through a hardened `/.otel` proxy. Logs no longer carry emails, names, or IP addresses.
