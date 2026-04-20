# OpenTelemetry Collector

Shared OpenTelemetry Collector for Better Stack (logs + traces) and LangFuse (traces). Used by backend and other apps when running via docker compose.

## Trace pipelines

Traces are split into two pipelines so **APM** and **LLM observability** do not receive identical data:

- **`traces/apm`** — Full traces (including PostgreSQL, HTTP, DNS, and other Node auto-instrumentation) → Better Stack.
- **`traces/llm`** — **Allowlisted** spans only → LangFuse (or any OTLP endpoint you configure on that exporter).

The allowlist (`filter/llm_only`) keeps a span when **either**:

1. **Tier 1 — Gen AI semantics**: the span has any of the checked `gen_ai.*` attributes (OpenTelemetry Gen AI semantic conventions), or  
2. **Tier 2 — Stack identity**: `instrumentation_scope.name` matches `(langfuse|langchain|langgraph)` (case-insensitive).

Everything else is dropped on the LLM pipeline only. If you point the LLM exporter at another backend (Honeycomb, Tempo, etc.), the same rules apply.

To extend the allowlist (e.g. another framework), edit the OTTL expression in `config.yaml` or add attribute keys under Tier 1.

This is intended to be used only when running in ctx| environment (BetterStack + LangFuse). You can use this as inspiration for your own specific collector when self-hosting but unless you're using the same observability stack it's not good fit.

## Setup

1. Copy the env template and create both env files (both are required by docker compose):
   ```bash
   cp apps/otel-collector/.env.example apps/otel-collector/.env
   cp apps/otel-collector/.env.example apps/otel-collector/.env.local
   ```
2. Put your local secrets in `.env.local` (it overrides `.env`). Set `BETTER_STACK_TOKEN`, `LANGFUSE_*` vars (see `.env.example` for how to derive `LANGFUSE_AUTH_STRING` and `LANGFUSE_OTLP_ENDPOINT`).

The collector loads `.env` then `.env.local` when started via docker compose. Without valid tokens, exports to Better Stack and LangFuse will fail.
