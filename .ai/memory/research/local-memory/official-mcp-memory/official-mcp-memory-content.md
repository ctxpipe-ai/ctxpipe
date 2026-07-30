# Official MCP Knowledge Graph Memory Server Content Model

Sources: https://www.npmjs.com/package/@modelcontextprotocol/server-memory, https://github.com/modelcontextprotocol/servers, https://beta.mcp.so/server/memory/modelcontextprotocol?tab=content, https://www.vibeindex.ai/mcp/modelcontextprotocol/servers/tree/main/src/memory

## What It Stores

The official MCP Memory Server stores a local knowledge graph with two main record types:

- entities;
- relations.

Entities contain:

- unique name;
- entity type;
- list of observations.

Relations contain:

- source entity;
- target entity;
- relation type.

The graph is persisted locally, historically as JSON/JSONL depending on version and packaging.

## Semantics / Types It Looks For

The server itself does not infer semantics. It exposes tools and schemas that ask the model/client to provide:

- entities such as people, organizations, events, projects, or concepts;
- observations as atomic facts about entities;
- relations as active-voice directed edges between entities.

## Extraction Prompt

No extraction prompt is built into the server. Memory extraction is delegated to the agent/model using tool descriptions.

Public tool schema/code mirror: https://glama.ai/mcp/servers/%40modelcontextprotocol/github/blob/b7e1cf3a79d421a70abe67876863430a9c049158/src/memory/index.ts

Tool descriptions define the prompt surface:

- `create_entities`;
- `create_relations`;
- `add_observations`;
- `delete_entities`;
- `delete_observations`;
- `delete_relations`;
- `read_graph`;
- `search_nodes`;
- `open_nodes`.

## How It Manages Memory Soup

The official server has minimal soup management:

- structured entity/relation/observation model prevents total free-form dumping;
- `search_nodes` limits loaded context by query;
- `open_nodes` fetches exact entities;
- delete tools allow cleanup.

But it lacks:

- extraction quality controls;
- semantic deduplication;
- stale/decay handling;
- provenance;
- confidence;
- typed lifecycle;
- branch/project scoping;
- compaction.

## Notes For ctxpipe

This is a useful baseline schema but insufficient as a production coding-agent memory model. If used, it needs typed scopes, provenance, lifecycle, and review layers.

