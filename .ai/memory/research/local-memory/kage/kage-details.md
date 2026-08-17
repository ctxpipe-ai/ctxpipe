# Kage Details

Sources: https://github.com/MushroomFleet/Kage, https://github.com/MushroomFleet/Kage/blob/main/README.md (search result), https://github.com/MushroomFleet/Kage/blob/main/docs/tutorials (search result)

## Snapshot

Kage is a local-only, graph-backed MCP memory server for AI assistants. It is designed to be privacy-first, run on a user's machine, and provide persistent semantic relationships for assistants.

Status: public repository. Public snippets describe MIT licensing, Python 3.12+, Docker/local setup, and a local web dashboard.

## How It Works

Kage exposes a knowledge graph through MCP. It stores entities, observations, and relationships, then allows AI assistants to create, search, and retrieve knowledge. Compared with the official MCP memory server, Kage is positioned as a more complete local graph memory stack with local-only operation and tooling.

Capabilities described in public docs/snippets:

- graph-based memory;
- local-only runtime;
- MCP tool interface;
- web dashboard;
- Docker compose and local development workflows;
- relationship tracking between remembered concepts.

## Storage And Data Model

The public positioning is graph-first. Exact storage backend should be verified in the repo, but Kage is not described as a managed cloud service; it is designed to persist locally. Entities and relationships are the primary model.

## Integrations

Kage integrates with MCP clients. It is most relevant for Claude Desktop/Claude Code-style assistants, but any client capable of running an MCP server can use it.

## Selling Points

- Local-only privacy posture.
- Graph memory rather than flat note files.
- Docker/local setup.
- Dashboard for inspection.
- Open-source and self-contained.

## Open/Closed Source And Target Users

Open-source: yes, public repo; snippets report MIT license.

Target users: individual developers and privacy-conscious users who want a local graph memory server. Team use would require reviewing concurrency, user identity, and backup/sync patterns.

## Risks And Unknowns

- Independent public feedback is limited.
- Graph extraction/retrieval quality needs local evaluation.
- Dashboard and Docker setup add moving parts compared with a file-only memory system.
- Coding-specific concepts such as branches, tasks, and worktrees are not clearly first-class.

