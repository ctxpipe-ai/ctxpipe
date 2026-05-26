# Engram MCP Content Model

Sources: https://github.com/edg-l/engram-mcp

## What It Stores

Public search results were too sparse to identify a detailed schema. Engram MCP appears to store persistent memory records for MCP-compatible agents, likely:

- memory text;
- metadata;
- retrieval/search data.

## Semantics / Types It Looks For

No stable public ontology was found. Based on the project category, it likely stores generic assistant memories rather than coding-specific task state.

## Extraction Prompt

No public extraction prompt was found.

## How It Manages Memory Soup

Unknown from public sources. Possible controls are limited to MCP tool boundaries and whatever persistence/search backend the repo implements.

Important unknowns:

- whether storage is local file, SQLite, vector, or remote;
- whether records are typed;
- whether there is deduplication;
- whether stale memories are aged or deleted;
- whether provenance is stored.

## Notes For ctxpipe

Engram MCP needs direct code inspection before it can inform design. It currently contributes little beyond being another lightweight MCP memory implementation.

