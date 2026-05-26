# MCP Memory Service Details

Sources: https://github.com/doobidoo/mcp-memory-service, https://github.com/alphaplapplap/mcp-memory-service, Reddit and MCP listings surfaced in search

## Snapshot

MCP Memory Service is a universal semantic memory service for AI assistants. It supports Claude Desktop, Claude Code, VS Code, Cursor, Continue, and other MCP clients. Public search results describe SQLite-vec local search, semantic memory, natural memory triggers, OAuth/team collaboration, and optional Cloudflare-based distribution.

Status: public open-source repository family. Verify canonical repo, current license, and active maintainer before adoption because search results showed mirrored/forked repository paths.

## How It Works

The system exposes memory over MCP and adds "natural memory triggers" for Claude Code, where hooks/controllers detect when memory context should be used without explicit user commands.

Capabilities described publicly:

- semantic memory storage and search;
- SQLite-vec local vector search;
- intelligent trigger detection;
- Claude Code HTTP transport;
- OAuth 2.1/team collaboration in later versions;
- support for many AI applications.

## Storage And Data Model

Public docs/search snippets emphasize SQLite-vec for local semantic search. It also includes a knowledge graph component in some descriptions. The precise schema and cloud/team split should be inspected in the repo.

## Integrations

Named integrations include Claude Desktop, Claude Code, VS Code, Cursor, Continue, and other MCP-compatible clients. Installation includes a Python installer and optional Claude hooks.

## Selling Points

- More mature MCP operational scope than simple memory servers.
- Local SQLite-vec is lightweight compared with Qdrant/Neo4j stacks.
- Natural triggers reduce the need for explicit "search memory first" prompting.
- Team/collaboration features may matter for organizations.

## Open/Closed Source And Target Users

Open-source: appears yes, but confirm canonical license.

Target users: power users and teams wanting a general MCP memory service across clients. It may be too broad/heavy for a focused repo memory design unless its trigger and SQLite patterns are reused.

## Risks And Unknowns

- Search results mention enterprise security and Cloudflare distribution, which expands trust/security review scope.
- Canonical repository naming is confusing in search results.
- Hook/trigger systems can be brittle across client versions.
- Need to verify data locality, auth, and multi-user boundaries.

