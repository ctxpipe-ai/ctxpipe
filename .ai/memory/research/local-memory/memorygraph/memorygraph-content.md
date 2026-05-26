# MemoryGraph Content Model

Sources: https://github.com/memory-graph/memory-graph, https://github.com/gregorydickson/memorygraph

## What It Stores

MemoryGraph stores graph memory for AI/coding agents. Public search snippets indicate:

- memory nodes;
- relationships;
- observations/facts;
- optional SQLite persistence;
- optional FalkorDB Lite backend.

## Semantics / Types It Looks For

Public material describes persistent memory for:

- patterns;
- relationships;
- knowledge across sessions;
- preferences and project facts, depending on what the agent writes.

The precise node and edge taxonomy was not visible in search results.

## Extraction Prompt

No public extraction prompt was found. MemoryGraph appears to expose graph-memory tools through MCP and relies on agent tool calls/instructions rather than a published extractor.

## How It Manages Memory Soup

Known/likely controls:

- graph structure instead of flat append-only text;
- relationship tracking;
- local SQLite default;
- query/retrieval through MCP.

Unknown controls:

- deduplication;
- decay;
- stale fact invalidation;
- provenance;
- confidence;
- branch/project scoping.

## Notes For ctxpipe

MemoryGraph is conceptually relevant but under-specified publicly. It should be code-audited before using it as more than a graph-memory example.

