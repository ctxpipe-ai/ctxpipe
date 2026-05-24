# MCP Memory Service Content Model

Sources: https://github.com/doobidoo/mcp-memory-service, https://github.com/alphaplapplap/mcp-memory-service

## What It Stores

Public search results describe MCP Memory Service as a semantic memory service using local vector search, with some versions referencing knowledge graph behavior and later collaboration/auth features. It stores user/agent memories and searchable semantic records.

Likely stored content includes:

- memory text;
- embeddings;
- metadata;
- timestamps;
- client/session context;
- possibly graph relationships in newer versions.

## Semantics / Types It Looks For

The public surface was not clear enough to enumerate a stable ontology. The likely semantics are generic assistant memories:

- facts;
- preferences;
- project details;
- useful prior context;
- session-derived observations.

Claude Code "natural trigger" integrations suggest it may also store coding-relevant context, but exact categories were not visible in this pass.

## Extraction Prompt

No public extraction prompt was found in accessible search results. The system appears MCP/tool-trigger driven, with optional natural triggers/hooks for Claude Code.

Canonical repo should be verified before deeper prompt analysis because search exposed multiple repository paths.

## How It Manages Memory Soup

Reported/visible controls:

- SQLite-vec local semantic search;
- structured MCP operations;
- natural trigger detection to decide when memory should be used;
- local store rather than raw prompt stuffing;
- team/auth features in later versions.

Unknown controls:

- deduplication;
- decay;
- confidence;
- extraction categories;
- provenance;
- stale-memory cleanup.

## Notes For ctxpipe

The main useful pattern is local SQLite semantic indexing behind MCP. It needs code inspection before we can trust its content model.

