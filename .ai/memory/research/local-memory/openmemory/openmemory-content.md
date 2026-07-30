# OpenMemory Content Model

Sources: https://mem0.ai/openmemory, https://docs.mem0.ai/platform/mem0-mcp, https://github.com/mem0ai/mem0

## What It Stores

OpenMemory is Mem0's MCP-oriented packaging for coding agents. Public product pages describe it as storing developer/coding-agent memories rather than a separate public schema. It appears to inherit Mem0's extracted memory records, while emphasizing:

- coding preferences;
- implementation knowledge;
- setup/project details;
- user style and workflow preferences;
- memories shared across MCP clients.

## Semantics / Types It Looks For

The landing page highlights typed memories such as user preference and implementation knowledge. Inferred from Mem0's underlying prompts and OpenMemory's coding-agent positioning, likely memory targets include:

- user preferences;
- coding style;
- implementation conventions;
- project knowledge;
- tool/setup facts;
- decisions made during agent sessions.

## Extraction Prompt

I did not find a standalone OpenMemory extraction prompt. The public implementation path appears to rely on Mem0 prompts and APIs.

Relevant Mem0 prompt file: https://github.com/mem0ai/mem0/blob/main/mem0/configs/prompts.py

Relevant Mem0 MCP docs: https://docs.mem0.ai/platform/mem0-mcp

## How It Manages Memory Soup

OpenMemory likely inherits Mem0's anti-soup controls:

- extracted memories rather than raw transcript stuffing;
- vector/search-backed retrieval;
- metadata scoping;
- deduplication in the Mem0 extraction pipeline;
- entity/lexical search support in newer Mem0 versions;
- memory management UI/control plane in the product layer.

The public OpenMemory-specific soup controls were not detailed in accessible docs during this pass. This makes storage locality, review, deletion, and coding-specific scope important due-diligence items.

## Notes For ctxpipe

OpenMemory contributes the cross-agent MCP packaging idea. It is less useful as a content-model reference unless its coding-specific memory schema becomes publicly inspectable.

