# Codebase-Memory MCP Details

Sources: https://github.com/cranbis/codebase-memory, https://github.com/cranbis/codebase-memory/blob/main/README.md (search result)

## Snapshot

Codebase-Memory MCP is a focused MCP server for building and querying persistent codebase knowledge. It targets the problem of AI assistants losing understanding of project structure and decisions.

Status: public repository surfaced in search results. License, activity, and exact install path should be verified in the repo before adoption.

## How It Works

The system lets agents store and retrieve memories about codebase structure, decisions, dependencies, and implementation patterns. It is more codebase-oriented than personal-memory tools and more memory-oriented than pure code-search tools.

Public snippets indicate:

- MCP server interface;
- persistent codebase context;
- repository-aware memory;
- query/search over stored project knowledge.

## Storage And Data Model

Exact backend was not visible in search snippets. The project should be audited for:

- whether memory is file-backed, SQLite-backed, or vector-backed;
- whether memories are scoped by repo/path/branch;
- whether schema distinguishes decisions, patterns, files, dependencies, and tasks;
- import/export and git compatibility.

## Integrations

MCP-compatible coding assistants are the primary integration target.

## Selling Points

- Narrowly focused on codebase memory.
- Avoids the general-purpose personal memory sprawl problem.
- Potentially useful as a design reference for repo-scoped schemas.

## Open/Closed Source And Target Users

Open-source: public repo, license to verify.

Target users: developers using coding agents over larger repositories. Team fit is unknown.

## Risks And Unknowns

- Low public sentiment/adoption evidence.
- Unknown storage and retrieval architecture.
- May overlap with code search, documentation, and memory-bank files.
- Needs repo audit before serious consideration.

