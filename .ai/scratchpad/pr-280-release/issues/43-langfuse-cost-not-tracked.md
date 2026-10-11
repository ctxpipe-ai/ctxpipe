# Langfuse: no cost for any model call

Status: ready-for-agent
Priority: P2
Owner: unassigned
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
