# Dory Details

Sources: https://dory.deeflect.com/, https://github.com/deeflect/dory

## Snapshot

Dory is a local-first shared memory daemon for multiple AI agents. Its core idea is simple: all agents read from and write to the same markdown corpus on disk, while SQLite is a rebuildable index.

Status: open source, MIT licensed according to the site. Python 3.12+, native MCP, CLI, HTTP daemon, and browser wiki.

## How It Works

Dory runs a small daemon locally. Agents interact through five verbs:

- `wake`: load bounded hot context at session start;
- `search`: hybrid BM25 plus vector search across the corpus;
- `get`: fetch exact markdown with a content hash;
- `memory-write`: semantic writes auto-routed to canonical pages;
- `link`: create backlinks and graph relationships.

The source of truth is markdown. SQLite is disposable and can be rebuilt from the corpus if corrupted. Dory exposes CLI commands, HTTP endpoints, a native MCP server over stdio or TCP, and a browser wiki.

## Storage And Data Model

Storage is a folder of markdown files. Example paths from the site include:

- `core/active.md`;
- `decisions/*.md`;
- `people/*.md`;
- `projects/*/state.md`.

SQLite indexes the corpus for search. The design is file-first, inspectable, and compatible with editors like Obsidian.

## Integrations

Dory is designed for Claude, Codex, Hermes, OpenClaw, and any MCP-aware host. It also exposes HTTP endpoints and an Obsidian-friendly corpus.

## Selling Points

- Maximum inspectability: memory is markdown.
- One corpus shared by many agents.
- No SaaS account, phone-home, or proprietary migration format.
- Rebuildable index limits corruption risk.
- Small API surface makes it easier to reason about.

## Open/Closed Source And Target Users

Open-source: yes, MIT according to the site.

Target users: local-first individuals and teams who value human-readable memory and already maintain project notes. It is especially interesting for multi-agent workflows where the same developer moves among Claude, Codex, and other tools.

## Risks And Unknowns

- Markdown-first memory can become stale without conventions and pruning.
- It is unclear how concurrent multi-agent writes are merged or locked.
- Semantic write auto-routing needs careful review to avoid silently modifying the wrong page.
- Less suitable for high-scale app memory or multi-tenant SaaS memory.

