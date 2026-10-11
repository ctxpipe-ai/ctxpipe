# Langfuse: Workspace chat generations have no model, no token counts, and no prompt or output

Status: ready-for-agent
Priority: P1
Owner: unassigned
Blocked by: none
Created: 2026-10-11
Updated: 2026-10-11

## Context

Each model call that the chat sandbox makes goes through the backend proxy `POST /:orgSlug/api/v1/workspace-chat/openai/v1/chat/completions`. The backend records a `generation #N` span, which Langfuse shows as a GENERATION.

## Evidence

Ticket 37 UI turn (conversation `conv_0564162ac1153f4e3336619476b5f981`, 2026-10-11 01:18:09 to 01:18:26 UTC, `pr-280`). Langfuse traces `cad42b8c20a845ca8fd2b5ca8bec2c36`, `f6a8d4f8c33b11014a85b4c0083aa14d`, `40f5c9456f4ec81dab7537b52b2765dd`, `8bedcb08cd91f1dde0b29ceee3f3111f`, `0d9dd1f7067fc0aef3592fa7469e8d3b`, `f429f31cf1133a3f8b6a08a57852eaf0`:

- trace `name` is empty;
- `provided_model_name` is null;
- `usage_details` is empty;
- `input` and `output` are empty;
- latency is present (`generation #1`: 2,519 ms, TTFB 1,212 ms).

The MCP turn (trace `0ae4180de87efbe8a934fceebcc1b5b8`, 01:23:35 UTC) has the same gap on its per-call traces (`20ffc2c997fccd20142cbdb30c287b62`, `3e349bdc5bbf50aa6f19f982d8efb85b`, `7f8b336355cbb3ae289c0a56a93aba36`).

Only the TanStack summary span (`chat ctxpipe/openai/gpt-5.6-terra`) has a model and tokens. There, Langfuse shows `input: 0` while the span has `gen_ai.usage.input_tokens=359` and `gen_ai.usage.cache_read.input_tokens=6838`. The input mapping looks wrong.

Likely cause: `apps/backend/src/domain/workspaces/workspace-chat-otel.ts` sets only `gen_ai.operation.name`, the index, TTFB, duration, and finish reason on the generation span. The proxy (`apps/backend/src/routes/v1/workspace-chat-openai.ts`, `domain/workspaces/workspace-chat-model-proxy.ts`) knows the request model, the response `usage`, and the messages, but does not put them on the span.

## Expected vs actual

- Expected: each generation shows `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.input_tokens` / `output_tokens` (and cached tokens), and the prompt and completion (Langfuse input and output). The trace has a name, for example `workspace-chat`.
- Actual: latency only.

## Scope

- Set the model and usage attributes on the generation span from the proxied request and response (also for streamed responses: read the final `usage` chunk).
- Set prompt and completion in the form the Langfuse span processor reads (the ClickHouse pipeline already removes them from HyperDX).
- Name the trace.
- Check the input-token mapping on the TanStack span (`input: 0`).
- Test with the in-memory exporter and an msw model provider.

## Acceptance criteria

- [ ] A chat turn on a preview shows model, tokens, prompt, and output on every generation in Langfuse.

## Comments

## Resolution
