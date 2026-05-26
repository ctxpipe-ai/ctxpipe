# Engram MCP Details

Sources: https://github.com/edg-l/engram-mcp, https://www.engram.to/ (related product name, not assumed same implementation)

## Snapshot

Engram MCP is a memory service compatible with the Model Context Protocol. The public repository positions it as a memory server that gives agents persistent context across conversations.

Status: public repository. It appears to be a lightweight MCP memory implementation rather than a full commercial platform.

## How It Works

Engram MCP exposes MCP tools for saving and retrieving memories. The intent is to let assistants persist facts and later search or load them. Public search results do not expose enough schema detail to classify it as graph-first, vector-first, or markdown-first without repo inspection.

## Storage And Data Model

Storage details were not clearly visible from search snippets. The project should be audited directly for:

- memory persistence backend;
- search algorithm;
- schema;
- import/export path;
- local-only versus remote operation;
- license and maintenance activity.

## Integrations

Any MCP-capable client can integrate if it can run the server. Likely targets are Claude Desktop, Claude Code, Cursor, VS Code, and other MCP hosts.

## Selling Points

- Simple MCP compatibility.
- Focus on persistent memory rather than full agent runtime.
- Potentially easier to reason about than large memory platforms.

## Open/Closed Source And Target Users

Open-source: public GitHub repository, but license should be verified.

Target users: MCP users wanting a lightweight memory server. Fit for teams is unknown.

## Risks And Unknowns

- Sparse public documentation in search results.
- Unknown storage, search, and lifecycle mechanics.
- Low independent sentiment.
- Name collision with Engram commercial/consumer AI memory pages could confuse discovery.

