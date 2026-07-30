# Kage Content Model

Sources: https://github.com/MushroomFleet/Kage

## What It Stores

Kage is described as a local-only graph-backed MCP memory server. It stores:

- entities;
- observations;
- relationships;
- local graph memory state.

It also exposes a dashboard for inspection.

## Semantics / Types It Looks For

The public summary points to classic knowledge-graph semantics:

- entities;
- facts/observations about entities;
- relations between entities;
- persistent assistant/user/project knowledge.

No richer coding-specific ontology was found in accessible search results.

## Extraction Prompt

No extraction prompt was found. Kage appears tool-driven through MCP, with the LLM deciding which entities/relations/observations to write.

## How It Manages Memory Soup

Controls visible from public positioning:

- local-only operation;
- graph structure;
- dashboard inspection;
- MCP tool boundaries.

Unknown controls:

- semantic deduplication;
- confidence;
- provenance;
- stale memory decay;
- entity merge;
- branch/project scopes.

## Notes For ctxpipe

Kage is useful as another local graph-memory design. The missing piece is workflow-specific semantics: coding memory needs decisions, tasks, corrections, and project scope, not just entities.

