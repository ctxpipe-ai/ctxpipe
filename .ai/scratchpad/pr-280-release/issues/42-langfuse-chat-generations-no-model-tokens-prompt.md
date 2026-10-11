# Langfuse: Workspace chat generations have no model, no token counts, and no prompt or output

Status: ready-for-human
Priority: P1
Owner: agent (obs-llm-traces)
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

Cause: the proxy knew the request model, the messages, and the response `usage`, but `workspace-chat-otel.ts` put only timing and the finish reason on the `generation #N` span. A streamed answer also had no `usage` chunk, because the proxy did not ask for one. A plain JSON answer was not read at all: its only line has no newline, and the observer read only complete lines.

Fix (branch `obs-llm-traces`):

- The proxy sets `stream_options.include_usage=true` on a streamed request. The observer reads `model` and `usage` (`prompt_tokens`, `completion_tokens`, `prompt_tokens_details.cached_tokens`, and the gateway `cost`), and reads the last line when the body ends.
- The generation span gets `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cost`, and the prompt and answer as `langfuse.observation.input` / `output` (JSON, at most 64 KiB each). The ClickHouse pipeline already removes those two keys from HyperDX.
- Prompt and answer go through `maskCredentialsDeep` (ticket 32) before they reach the span.
- The trace name comes from ticket 41: a socket turn is a `workspace-chat` trace.
- The TanStack `chat <model>` summary span: Langfuse showed `input: 0` because OpenCode reports input tokens without the cached tokens (359 + 6,838 cached), and Langfuse subtracts the cached count from the input count. The summary span and its iteration spans are now `langfuse.observation.type=span`, so the turn does not count the tokens and cost of its generations two times. HyperDX keeps the summary usage.

Test: `workspace-chat-openai.attribution.integration.test.ts` ("records the model, the tokens, the cost, the prompt, and the output of a streamed generation") streams SSE from an msw provider and asserts the upstream `stream_options`, each attribute, and a masked GitHub token in the prompt.

To prove after a deploy: open a chat generation in Langfuse. Expect the model, the tokens, the input, the output, and a cost. Also check that Langfuse shows the TanStack summary as a span with no cost; if it still shows a cost, remove the usage from it in a span processor.


Review round 1 (security): the evlog span exporter logged all the attributes of each `generation #` span, so the prompt and output went to stdout and to HyperDX `otel_logs`. The exporter now drops the keys that match `LLM_CONTENT_KEY`, which is the same pattern as the collector trace rule (a test reads `config.yaml` to keep the two the same). The collector `logs/out-default` pipeline also blanks those JSON members (`transform/redact_llm_log_content`), as a second guard. I ran that rule in `clickstack-otel-collector:2.39.1` with a sample evlog line. The collector change needs an image build and a deploy of the observability project.
