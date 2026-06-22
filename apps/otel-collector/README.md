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

1. Copy the env template and create local overrides:
   ```bash
   cp apps/otel-collector/.env.example apps/otel-collector/.env
   cp apps/otel-collector/.env.local.example apps/otel-collector/.env.local
   ```
   For Langfuse Cloud instead of local self-hosting, use `.env.example` for both files.
2. Put secrets in `.env.local` (it overrides `.env`). Set `BETTER_STACK_TOKEN`, `LANGFUSE_*` vars (see `.env.example` for how to derive `LANGFUSE_AUTH_STRING` and `LANGFUSE_OTLP_ENDPOINT`).

The collector loads `.env` then `.env.local` when started via docker compose. Without valid tokens, exports to Better Stack and LangFuse will fail.

## Local self-hosted Langfuse

Use this when Langfuse runs on your machine (for example via [Langfuse Docker Compose](https://langfuse.com/self-hosting/deployment/docker-compose)) and you want LLM traces in the local UI during host dev.

1. **Start Langfuse** on the host (default UI: `http://localhost:3000`). Create a project and API keys in project settings.
2. **Configure the collector** — copy the local template and fill in secrets:
   ```bash
   cp apps/otel-collector/.env.local.example apps/otel-collector/.env.local
   ```
   URLs use `host.docker.internal` because the collector runs **inside Docker** and must reach Langfuse on the host. Do not use `localhost` in collector env — that refers to the container, not your machine.
3. **Configure the backend** — in `apps/backend/.env.local`, set OTLP endpoints to the collector on the host (see [apps/backend/.env.example](../backend/.env.example)):
   - `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4318/v1/traces`
   - `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://localhost:4318/v1/logs`
   - `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://localhost:4318/v1/metrics`
4. **Start infra** and restart the collector after env changes:
   ```bash
   pnpm dev:infra
   docker compose --profile infra up -d otel-collector
   ```
5. **Run the app** (`pnpm dev` from repo root), trigger an LLM conversation or agent flow, then confirm traces appear in the Langfuse UI.

**Port note:** With normal `pnpm dev` (portless on HTTPS 443), Langfuse on host `:3000` does not conflict with ctxpipe. If you run the backend bare on host `:3000` (headless VM runbook), remap Langfuse to another host port or change backend `PORT`.

## Better Stack quota (HTTP 402) and log noise

If Better Stack returns **HTTP 402 — Quota reached**, the OTLP exporter treats that as a **permanent** failure: batches are dropped and the collector logs `Exporting failed. Dropping data` for each failure. That is a **billing / plan limit** on the Better Stack side, not a bug in this repo.

**What actually fixes delivery:** raise the Better Stack quota, reduce ingest (sample or disable auto-instrumentation spans you do not need), or temporarily stop sending telemetry to Better Stack (for example unset `OTEL_EXPORTER_OTLP_*` on services or remove the Better Stack exporter from `config.yaml` in your deployment fork).

**What this repo does to help:** pipelines that export to Better Stack use a **larger batch** (`batch/betterstack`: 5s timeout, 512 items) so fewer HTTP requests are made for the same traffic, which reduces both quota pressure and the rate of error lines when the quota is already exceeded.

**Langfuse `Span not found in runMap` warnings** were caused by attaching the same Langfuse `CallbackHandler` more than once per LangGraph run (graph boundary + nested node callbacks). Attach the handler once at workflow entry; do not re-add it in graph nodes.
