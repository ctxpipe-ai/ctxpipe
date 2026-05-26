# LangMem / LangGraph Memory Content Model

Sources: https://langchain-ai.github.io/langmem/concepts/conceptual_guide/, https://langchain-ai.github.io/langmem/guides/extract_semantic_memories/, https://langchain-ai.github.io/langmem/guides/extract_episodic_memories/, https://langchain-ai.github.io/langgraph/concepts/memory/, https://www.langchain.com/blog/langmem-sdk-launch

## What It Stores

LangMem/LangGraph stores memory according to three long-term categories plus graph/thread state:

- semantic memory: facts and knowledge;
- episodic memory: past experiences and examples;
- procedural memory: behavior, rules, and instructions;
- short-term thread state/checkpoints;
- long-term store records across threads.

Semantic memory can be represented as profiles or collections. Episodic memory can be stored as examples with context, reasoning, and outcomes. Procedural memory can be prompt rules or stored/updatable instructions.

## Semantics / Types It Looks For

LangMem's docs explicitly ask designers to decide what the agent should learn:

- facts and knowledge;
- summaries of past events;
- rules and style;
- successful interaction episodes;
- reasoning process that led to success;
- behavior patterns and response style.

The semantic-memory guide shows structured extraction into triples such as subject, predicate, object, and optional context. The episodic-memory guide uses structured episodes with fields like observation/situation, thoughts/reasoning, action, and result.

## Extraction Prompt

LangMem's extraction prompt is user-configurable through `create_memory_manager`, `instructions`, Pydantic schemas, and existing memory state. The exact internal default prompt was not surfaced in search results, but docs describe the pattern:

1. pass conversation plus current memory state;
2. prompt an LLM to expand or consolidate memory;
3. return updated memory state.

Prompt/docs links:

- conceptual guide: https://langchain-ai.github.io/langmem/concepts/conceptual_guide/
- semantic extraction: https://langchain-ai.github.io/langmem/guides/extract_semantic_memories/
- episodic extraction: https://langchain-ai.github.io/langmem/guides/extract_episodic_memories/
- launch example with custom instructions: https://www.langchain.com/blog/langmem-sdk-launch

## How It Manages Memory Soup

LangMem/LangGraph manages soup through design separation:

- semantic, episodic, and procedural memories are different stores/shapes;
- developers can define schemas for extracted memory;
- memory managers receive existing state to consolidate rather than blindly append;
- prompt optimizer can refine procedural memory from feedback;
- LangGraph checkpoints keep working state separate from durable memory;
- namespace/store APIs scope long-term memories;
- background memory processing can avoid blocking the main interaction.

The main risk is that the framework leaves many choices to the developer. Without good schemas and policies, memory can still degrade into generic records.

## Notes For ctxpipe

The three-type taxonomy is useful for ctxpipe: facts/decisions, episodes/debugging outcomes, and procedures/preferences should not be mixed.

