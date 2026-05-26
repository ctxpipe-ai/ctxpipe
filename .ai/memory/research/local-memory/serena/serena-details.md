# Serena Details

Sources: https://github.com/oraios/serena, https://github.com/oraios/serena/blob/main/README.md (search result), https://github.com/oraios/serena/issues (public repo)

## Snapshot

Serena is an open-source coding-agent toolkit and MCP server that gives agents IDE-like semantic code tools. It also includes project memory files that agents can read/write for persistent context.

Status: public open-source repository.

## How It Works

Serena's primary value is language-server-based code intelligence:

- symbol search;
- references;
- file/symbol editing;
- project activation;
- semantic navigation.

Its memory feature stores project-specific notes under a Serena-managed memory directory. Agents can list/read/write memories about project conventions, architecture, or task context. This memory is coupled to code intelligence rather than standing alone as a personal memory database.

## Storage And Data Model

Serena stores memories as local project artifacts. Exact path and format should be verified from the repo/config, but the model is file-backed notes accessible through MCP tools. Code intelligence uses language server/project indexes.

## Integrations

Serena runs as an MCP server and is used with Claude Code, Claude Desktop, Cursor, and other MCP clients. It can be added to coding agents to improve repository understanding.

## Selling Points

- Memory plus semantic code navigation in one MCP server.
- Local and open-source.
- Useful for coding agents even if memory is minimal.
- Helps reduce brittle text search/edit workflows.

## Open/Closed Source And Target Users

Open-source: yes.

Target users: individual developers and teams using MCP-compatible coding assistants. It is especially relevant when the main problem is codebase understanding, not personal memory.

## Risks And Unknowns

- Memory is secondary to code intelligence; it may not have advanced retrieval, decay, or task state.
- Language-server setup can be project/language sensitive.
- Need to inspect how memory files are named, scoped, and updated.
- Could overlap with existing IDE/agent code tools.

