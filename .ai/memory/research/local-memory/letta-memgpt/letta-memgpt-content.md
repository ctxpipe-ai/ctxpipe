# Letta / MemGPT Content Model

Sources: https://docs.letta.com/guides/agents/memory-blocks/, https://docs.letta.com/guides/agents/archival-memory, https://docs.letta.com/guides/agents/architectures/memgpt, https://docs.letta.com/concepts/memory-management, https://docs.letta.com/letta-code/memory/

## What It Stores

Letta stores agent state across multiple memory tiers:

- core memory blocks;
- conversation/recall memory;
- archival memory passages;
- files/memory documents in Letta Code;
- system instructions and recent messages as in-context state.

Core memory blocks are labeled persistent sections of the context window. Common blocks:

- `human`: key user details;
- `persona`: agent identity/personality/capabilities;
- custom blocks such as organization, policies, scratchpad, working state, external state, performance tracking, or emotional state.

Archival memory stores longer-term semantically searchable facts, knowledge, documents, logs, examples, and reference material.

## Semantics / Types It Looks For

Letta does not impose one fixed ontology. It uses block labels and descriptions to tell the agent what each memory section means.

Common semantics:

- user profile and preferences;
- agent persona;
- working state;
- scratchpad;
- guidelines/policies;
- organization/team knowledge;
- external state mirrors;
- long-term facts and references;
- conversation history.

Archival memory docs recommend archival storage for documents, conversation logs beyond context window, customer history, reports, articles, code examples, technical references, training materials, user research, and historical records.

## Extraction Prompt

No single public extraction prompt governs all memory. Letta's "prompt" mechanism is the memory block itself: blocks are prepended to the agent prompt in XML-like structure with label, description, metadata, and value.

Prompt/memory links:

- memory block prompt rendering: https://docs.letta.com/guides/agents/memory-blocks/
- block descriptions and defaults: https://docs.letta.com/guides/agents/custom-memory
- archival memory tools: https://docs.letta.com/guides/agents/archival-memory
- architecture overview: https://docs.letta.com/guides/agents/architectures/memgpt

The block `description` is important because the agent uses it to decide how to read/write the block. This makes descriptions a semantic extraction guide.

## How It Manages Memory Soup

Letta manages soup through hierarchy:

- small always-visible core memory blocks have character limits;
- descriptions constrain what belongs in each block;
- blocks can be read-only;
- archival memory is queried on demand rather than always loaded;
- conversation history can be searched separately from curated archival memory;
- agents use explicit tools such as `archival_memory_insert` and `archival_memory_search`;
- developers can update/delete/list memory through APIs;
- memory blocks can be shared but remain labeled and bounded.

The main risk is that flexible blocks can become overloaded if labels/descriptions are vague. Letta's solution is to create purpose-specific blocks rather than one general memory field.

## Notes For ctxpipe

Letta's key lesson is a bounded hierarchy: always-visible hot memory, searchable long-term memory, and historical recall are separate things. ctxpipe should avoid making one file or store do all three jobs.

