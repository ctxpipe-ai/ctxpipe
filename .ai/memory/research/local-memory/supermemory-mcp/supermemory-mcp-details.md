# Supermemory MCP Details

Sources: https://supermemory.ai/mcp/, https://github.com/supermemoryai/supermemory-mcp, https://github.com/supermemoryai/supermemory/tree/main/apps/mcp, https://supermemory.ai/blog/the-ux-and-technicalities-of-awesome-mcps/, https://www.reddit.com/r/ClaudeAI/comments/1l8ayzr/i_made_a_memory_mcp_server_and_made_it_open/

## Snapshot

Supermemory MCP is a universal memory MCP that makes user memories available to MCP-compatible clients such as Claude, Cursor, VS Code, and Windsurf. It is distinct from SuperLocalMemory.

Status: public open-source MCP repo, with active code moving into the Supermemory monorepo. The broader Supermemory product includes hosted APIs/services.

## How It Works

The MCP server exposes Supermemory's memory API to local AI clients. Users install/configure the MCP server, then assistants can store and retrieve memories through MCP tools. It focuses on universal memory across apps rather than repo-local file memory.

The Supermemory blog on MCP UX argues that good MCP servers should have small, simple tool surfaces, good onboarding, and reliable hosted/remote operation where appropriate.

## Storage And Data Model

Storage is Supermemory-backed rather than plain local files. The exact data model is product-managed. This is important: it may be convenient and cross-client, but it is not the same trust model as local markdown/SQLite.

## Integrations

MCP-compatible tools:

- Claude;
- Cursor;
- VS Code;
- Windsurf;
- any MCP client.

The repo notes migration into `supermemoryai/supermemory/apps/mcp`.

## Selling Points

- Very easy universal memory concept.
- Good MCP UX focus.
- Cross-client memory sharing.
- Active project/product backing.

## Open/Closed Source And Target Users

Open-source: MCP server code is public. Backend/product service is managed.

Target users: individuals who want universal assistant memory quickly. For teams or privacy-sensitive code, deployment and data-retention review is required.

## Risks And Unknowns

- Not local-first in the same sense as Beads, Dory, Basic Memory, or SuperLocalMemory.
- Product-managed backend can create lock-in/privacy concerns.
- Less coding-workflow-specific; likely stores user memories rather than branch/task/codebase state unless extended.

