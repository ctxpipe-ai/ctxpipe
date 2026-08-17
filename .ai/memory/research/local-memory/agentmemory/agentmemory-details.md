# AgentMemory Details

Sources: https://www.agent-memory.dev/, https://github.com/rohitg00/agentmemory, https://www.producthunt.com/products/agent-memory-dev, https://langlabs.io/rohitg00/agentmemory

## Snapshot

AgentMemory is a local-first persistent memory runtime for AI coding agents. It targets Claude Code, Codex CLI, Cursor, Gemini CLI, OpenCode, Cline, Roo Code, Goose, Aider, and any MCP/REST-capable client. It is positioned as a complete capture-recall-consolidate runtime rather than a simple library or vector store.

Status: public open-source repository. The repo page reports Apache-2.0 licensing and a large GitHub star count. It is installable via `npm` / `npx` packages under `@agentmemory/*`.

## How It Works

The system runs a local Node service, with an MCP server and REST API in front of the same memory store. Agent integrations use hooks where possible, so agent events can be captured automatically rather than relying only on explicit "remember this" tool calls.

The architecture is built around three primitives:

- Hooks: session, prompt, tool-call, stop, and other lifecycle events are captured into raw observations.
- Recall: hybrid retrieval combines lexical/BM25, vector search, and graph relationships, followed by local reranking.
- Consolidation: periodic sweeps compress raw observations into semantic memories, merge duplicates, decay stale rows, and audit deletes.

AgentMemory claims one process and no external databases. The docs describe local embeddings and SQLite/embedded storage rather than Postgres, Qdrant, or Neo4j dependencies. It also ships a browser viewer on localhost for memory inspection and session replay.

## Storage And Data Model

The public docs emphasize:

- local data by default;
- compressed observations and semantic memory rows;
- graph-like relationships;
- session replay events;
- governance/audit records;
- filesystem connector support;
- MCP tools and REST twins for memory save, recall, smart search, sessions, governance, export, and delete.

Exact internal schema should be verified from the repository before adopting, but the public positioning is "local embedded runtime" rather than separate DB services.

## Integrations

Primary integrations:

- Claude Code native plugin/hook path;
- Codex CLI plugin path;
- OpenCode, Hermes, OpenClaw, pi/OpenHuman integrations according to the site;
- generic MCP server for Cursor, Claude Desktop, Gemini CLI, Cline, Roo, Kilo, Goose, Windsurf, and others;
- REST API for agents without MCP.

## Selling Points

- Automatic capture via hooks is the biggest differentiator versus systems that rely on the model deciding to call `remember`.
- No external DB is attractive for individual developers and local-first teams.
- Hybrid retrieval and benchmark reporting make it more ambitious than markdown-only memory.
- Session replay and viewer support answer a trust/debuggability need.
- Broad agent support matches real multi-agent developer workflows.

## Open/Closed Source And Target Users

Open-source: yes, Apache-2.0 according to the repo/site.

Target users: heavy coding-agent users, solo developers switching among agents, and teams that want one memory server per machine/repo. It appears most optimized for individuals and small teams first; enterprise governance would require deeper audit of access control, redaction, backup, and multi-user operation.

## Risks And Unknowns

- It is young and marketing-heavy, so benchmark and quality claims need local reproduction.
- Auto-capture creates a secret/privacy risk unless redaction is robust.
- Hook support varies by agent; MCP-only clients may get less automatic capture.
- The "capture everything" posture can drift into noise without strong consolidation and review tooling.
- Large star counts and many integrations should be validated against actual releases, issue health, and package provenance before adoption.

