# OpenTelemetry Collector

Shared OpenTelemetry Collector for Better Stack (logs + traces) and LangFuse (traces). Used by backend and other apps when running via docker compose.

This is intended to be used only when running in ctx| environment (BetterStack + LangFuse). You can use this as inspiration for your own specific collector when self-hosting but unless you're using the same observability stack it's not good fit.

## Setup

1. Copy the env template and create both env files (both are required by docker compose):
   ```bash
   cp apps/otel-collector/.env.example apps/otel-collector/.env
   cp apps/otel-collector/.env.example apps/otel-collector/.env.local
   ```
2. Put your local secrets in `.env.local` (it overrides `.env`). Set `BETTER_STACK_SOURCE_TOKEN`, `LANGFUSE_*` vars (see `.env.example` for how to derive `LANGFUSE_AUTH_STRING` and `LANGFUSE_OTLP_ENDPOINT`).

The collector loads `.env` then `.env.local` when started via docker compose. Without valid tokens, exports to Better Stack and LangFuse will fail.
