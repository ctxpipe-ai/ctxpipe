# Langfuse: no cost for any model call

Status: ready-for-human
Priority: P2
Owner: agent (obs-llm-traces)
Blocked by: none
Created: 2026-10-11
Updated: 2026-10-11

## Context

The ticket 37 scope asks for cost on each LLM call. Langfuse computes cost from its model price table, matched on the model name.

## Evidence

`langfuse.observations`, `pr-280`, 2026-10-11 01:17 to 01:25 UTC:

- `chat ctxpipe/openai/gpt-5.6-terra` (trace `a556044174efe5cf73a5df98f4fc44ff`): 451 tokens, `internal_model_id` null, `total_cost` null.
- MCP turn trace `0ae4180de87efbe8a934fceebcc1b5b8`: 754 tokens, cost 0.
- Repository ingestion traces `1e261e6a2130bf0436e71e13e6e9d5e2` (49 generations, 206,480 tokens, model `openai/gpt-6-luna`) and `55ce5ddb22ef430e2c1096b630e0047c` (53,912 tokens): cost 0.
- Embedding trace `eaf31039ce5f942fb9ef753a939709c8` (`openai/text-embedding-3-large`): cost 0.

Likely cause: the model names carry a gateway prefix (`ctxpipe/openai/...`, `openai/...`) that no Langfuse model definition matches, so `internal_model_id` stays null.

## Expected vs actual

- Expected: each generation has a cost in USD.
- Actual: null or 0.

## Scope

- Add Langfuse model definitions (a match pattern and prices) for the models the product uses, through the Langfuse API or MCP (`createModel`), and record them in `ops/observability/` so a rebuild keeps them. Or send the cost on the span (`gen_ai.usage.cost`) if the gateway returns it.
- Do not add an environment variable.

## Acceptance criteria

- [ ] New generations on a preview show a non-zero cost in Langfuse for chat, MCP, and ingestion.

## Comments

## Resolution

Cause (checked against the Langfuse model list on 2026-10-11):

- Chat generations sent no model and no usage (ticket 42). The built-in entry `gpt-5.6-terra` matches `(?i)^(openai/)?(gpt-5.6-terra)$`, so `openai/gpt-5.6-terra` gets a price, but `ctxpipe/openai/gpt-5.6-terra` (the TanStack summary span) does not.
- `openai/gpt-6-luna` and `xiaomi/mimo-v2.6-pro` have no built-in entry.
- The built-in `text-embedding-3-large` pattern has no `openai/` prefix, so `openai/text-embedding-3-large` does not match.

Fix (branch `obs-llm-traces`):

- Chat generations now send `gen_ai.request.model=openai/gpt-5.6-terra` (a built-in price) and `gen_ai.usage.cost` when the gateway reports it (OpenRouter puts `cost` in `usage`).
- `ops/observability/langfuse/models.json` holds custom entries for `openai/gpt-6-luna`, `xiaomi/mimo-v2.6-pro`, and `openai/text-embedding-3-large` at OpenRouter list prices. `ops/observability/langfuse/apply-models.sh` creates the missing entries through the Langfuse public API and skips the ones that exist. The README tells when to run it.
- No new environment variable.

Manual step for the team lead: run `LANGFUSE_AUTH_STRING=<base64 pk:sk> ops/observability/langfuse/apply-models.sh` once against `langfuse.ctxpipe.ai`. The agent did not change the shared Langfuse project. Langfuse prices only new generations; it does not change old ones.

Not done: the prices do not model the cache-read discount. Chat cost uses the gateway cost when it is present, which includes the discount.

Test: the ticket 42 integration test asserts `gen_ai.usage.cost` and `gen_ai.request.model` on the generation span.

To prove after the deploy and the script run: new chat, MCP, and ingestion generations on a preview show a cost that is not zero.

