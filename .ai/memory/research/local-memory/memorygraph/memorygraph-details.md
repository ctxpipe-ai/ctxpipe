# MemoryGraph Details

Sources: https://github.com/memory-graph/memory-graph, https://github.com/gregorydickson/memorygraph (repo path referenced in search result)

## Snapshot

MemoryGraph is a graph-based MCP memory server for coding agents. It gives AI agents persistent memory for patterns, relationships, and knowledge across sessions.

Status: public repository/package. Public snippets mention `memorygraphMCP` install via `pipx` and optional FalkorDB Lite backend.

## How It Works

MemoryGraph exposes a memory graph through MCP. Agents can store remembered items, connect them through relationships, and query them later. The quickstart is oriented around Claude Code:

- install the package;
- add it as a Claude MCP server;
- tell the agent to remember important facts such as testing preferences.

The project positions itself as more coding-agent-specific than the official MCP memory server.

## Storage And Data Model

Public snippets mention:

- default SQLite database;
- optional `falkordblite` backend;
- graph memory with intelligent relationship tracking.

The model likely contains memory nodes, typed relations, and observations/facts, but exact schema needs repo inspection.

## Integrations

Claude Code is the first-class quickstart. Other MCP clients are supported through generic MCP configuration.

## Selling Points

- Graph-first memory without requiring a separate hosted graph DB by default.
- Coding-agent positioning.
- Simple pipx install path.
- Optional graph backend for users who need richer graph operations.

## Open/Closed Source And Target Users

Open-source: public GitHub repository. Verify license before adoption.

Target users: coding-agent users who want structured relationship memory but do not want a full Mem0/Zep/Cognee stack.

## Risks And Unknowns

- Public sentiment and independent usage reports were limited.
- Need to verify concurrency behavior, schema, search quality, and repo activity.
- Graph memory can be hard for agents to use well unless the tool descriptions and write policy are excellent.

