# Official MCP Knowledge Graph Memory Server Details

Sources: https://www.npmjs.com/package/@modelcontextprotocol/server-memory, https://github.com/modelcontextprotocol/servers/blob/main/README.md, https://github.com/modelcontextprotocol/servers/issues/692

## Snapshot

The official MCP Memory Server is a reference knowledge-graph memory server. It was created to let Claude remember information across chats through entities, relations, and observations.

Status: open-source reference server, distributed as `@modelcontextprotocol/server-memory`.

## How It Works

The server exposes MCP tools for a simple local knowledge graph:

- entities are named nodes with an entity type and observations;
- relations are directed edges between entities;
- observations are atomic strings attached to entities.

Tools include create entities, create relations, add observations, delete entities/observations/relations, read graph, search nodes, and open nodes.

## Storage And Data Model

The storage model is intentionally basic:

- local JSON memory file;
- entity records;
- relation records;
- observation arrays.

It is a simple graph document store, not a vector search system and not a coding-specific memory runtime.

## Integrations

Runs as an MCP server over stdio. Usable with Claude Desktop and other MCP-compatible clients. Many community memory projects cite it as inspiration.

## Selling Points

- Minimal and easy to understand.
- Official/reference implementation value.
- Good learning substrate for MCP memory.
- No separate database required.

## Open/Closed Source And Target Users

Open-source: yes, from the Model Context Protocol servers collection.

Target users: developers experimenting with MCP memory, users wanting simple personal memory, and teams building more advanced memory servers.

## Risks And Unknowns

- Too primitive for serious coding-agent memory without adaptation.
- A GitHub issue reports confusion/bugs around custom storage paths and `memory.json` location under npm/npx cache paths.
- No semantic search, decay, provenance, branch awareness, or concurrency story.
- Local JSON file can become hard to manage as memory grows.

