# LlamaIndex Memory Content Model

Sources: https://developers.llamaindex.ai/python/framework/module_guides/deploying/agents/memory/, https://developers.llamaindex.ai/python/framework-api-reference/memory/

## What It Stores

LlamaIndex memory stores short-term chat history plus long-term memory blocks. Public docs name three predefined memory blocks:

- `StaticMemoryBlock`;
- `FactExtractionMemoryBlock`;
- `VectorMemoryBlock`.

The system can store:

- static core information;
- facts extracted from flushed chat history;
- batches of chat messages in vector stores;
- short-term recent turns;
- long-term blocks merged back into context.

## Semantics / Types It Looks For

Built-in semantics:

- static facts/instructions;
- extracted facts from chat history;
- semantically retrievable conversation/message batches.

The exact topics depend on block configuration and the LLM used. `FactExtractionMemoryBlock` is fact-oriented; `VectorMemoryBlock` preserves chat-message batches rather than extracting a typed ontology.

## Extraction Prompt

I did not find the full `FactExtractionMemoryBlock` prompt in accessible docs. The docs do describe behavior:

- flushed short-term messages are passed to long-term memory blocks;
- the fact extraction block uses an LLM to extract facts;
- `max_facts` limits retained facts;
- if facts exceed the limit, they are summarized/reduced.

Docs link: https://developers.llamaindex.ai/python/framework/module_guides/deploying/agents/memory/

## How It Manages Memory Soup

LlamaIndex has these controls:

- short-term and long-term memory are separate;
- memory blocks have priorities;
- `max_facts` limits the fact-extraction block;
- facts are summarized/reduced when exceeding the cap;
- vector memory retrieves top-k batches;
- retrieval context window controls how much recent conversation is used for vector query;
- node postprocessors can add thresholds or reranking.

The controls are framework primitives; application developers must still decide what facts matter and which blocks should be used.

## Notes For ctxpipe

LlamaIndex's useful pattern is the combination of static memory, extracted facts, and vectorized conversation batches with explicit caps. For ctxpipe, similar caps should apply to active context and procedural memories.

