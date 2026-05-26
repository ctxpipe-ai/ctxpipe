# Basic Memory Details

Sources: https://docs.basicmemory.com/, https://docs.basicmemory.com/reference/technical-information, https://docs.basicmemory.com/local/mcp-tools-local, https://github.com/basicmachines-co/basic-memory, https://mcp.directory/servers/basic-memory

## Snapshot

Basic Memory is a local-first knowledge management system that lets LLMs build and query a persistent semantic graph stored as local Markdown files. It is broader than coding-agent memory, but it is widely used as an MCP memory server and is relevant for project memory.

Status: open source. MCP Directory lists AGPL-3.0. Basic Memory also offers Cloud/local modes and optional sync.

## How It Works

Basic Memory uses a file-first architecture:

- Markdown files are the source of truth.
- A core knowledge engine parses and indexes the files.
- A database provides querying and search.
- An MCP server exposes tools.
- CLI tools manage projects.
- A file watcher keeps the secondary index in sync.

AI assistants can write notes, edit notes, search notes, read notes, and build context by graph traversal.

## Storage And Data Model

Memory lives in markdown with frontmatter and semantic sections. The docs show patterns like observations and relations:

- observations capture facts/insights;
- relations link notes with typed edges such as `relates_to` or `builds_on`;
- notes remain readable in Obsidian, VS Code, or any text editor.

The database is secondary. If it breaks, the markdown remains usable and can be reindexed.

## Integrations

Basic Memory exposes MCP tools for Claude, ChatGPT, Gemini, Cursor, VS Code, and other MCP-compatible clients. Tools include:

- `search_notes`;
- `read_note`;
- `write_note`;
- `edit_note`;
- schema tools;
- `build_context` for graph traversal;
- raw content read/delete tools.

## Selling Points

- Plain Markdown ownership.
- Semantic graph rather than unstructured notes only.
- Strong MCP tooling.
- Can support personal knowledge, research, writing, and project memory.
- Optional cloud/local modes support different user preferences.

## Open/Closed Source And Target Users

Open-source: yes, AGPL-3.0 per MCP Directory.

Target users: individuals, researchers, writers, knowledge workers, and developers who want a local knowledge base that agents can participate in. For teams, AGPL and sync/cloud choices need legal/operational review.

## Risks And Unknowns

- Not coding-agent-specific; task/branch/worktree semantics are not the default model.
- Agents may fail to write high-quality observations and relations unless prompted well.
- AGPL may complicate embedding into proprietary products.
- Large markdown corpora require conventions to prevent sprawl.

