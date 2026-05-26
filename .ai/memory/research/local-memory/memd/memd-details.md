# memd Details

Sources: https://memd.dev/, https://www.npmjs.com/package/@memd/mcp (package referenced by site)

## Snapshot

memd is an open-source MCP memory server for coding agents. It gives agents structured long-term memory for decisions, patterns, errors, schemas, constraints, solutions, checkpoints, progress logs, sessions, and persistent tasks.

Status: public project with open-source positioning. The landing page says MIT licensed and self-hosted, while the quickstart currently points to a hosted API at `api.memd.dev`. Verify repository URL and deployment options before adoption.

## How It Works

memd exposes a TypeScript MCP server over stdio. The MCP server talks to a REST API written in Go. The backend stores structured data in PostgreSQL and vector data in Qdrant, with embeddings generated through local ONNX where possible and OpenAI fallback where configured.

Main tool groups:

- `memd_store`, `memd_recall`, `memd_search`, `memd_list`, `memd_update`, `memd_delete`;
- checkpoint tools for resumable development state;
- progress log tools for append-only action history;
- session lifecycle tools;
- task create/update/list/get/delete tools with priority and dependency semantics.

The design separates memory entries, working-state snapshots, audit/progress logs, and task tracking.

## Storage And Data Model

The public model is structured and typed:

- context entries have key/type/priority/scope/tags/TTL;
- checkpoints capture completed steps, blockers, and next actions;
- progress logs are append-only trails of actions and outcomes;
- sessions track work periods;
- tasks have status, priority, and dependencies.

Storage:

- PostgreSQL for structured records and queries;
- Qdrant for vector similarity search;
- ONNX local embeddings with OpenAI fallback.

## Integrations

memd is MCP-first and works with any MCP-compatible agent. The public site names Claude Code, Copilot, and Cursor as examples. The setup command registers an API key and configures an MCP server entry.

## Selling Points

- Structured memory categories match coding workflows.
- Combines semantic search, SQL filters, checkpoints, task state, and progress logs.
- Has a clear API/tool surface instead of a vague "save memory" interface.
- TTL and priority-aware cleanup are built into the model.

## Open/Closed Source And Target Users

Open-source: advertised as open-source and MIT licensed.

Target users: individual developers and small teams that want a complete MCP memory API with typed records. It is less "zero infrastructure" than markdown or embedded-SQLite tools because its documented architecture uses Postgres and Qdrant.

## Risks And Unknowns

- Hosted API in quickstart conflicts with "self-hosted" messaging unless self-host docs are mature.
- Postgres plus Qdrant may be too heavy for a local repo memory system.
- Public sentiment was sparse in this pass.
- Need to inspect the repo for schema, migrations, auth model, and local deployment story.

