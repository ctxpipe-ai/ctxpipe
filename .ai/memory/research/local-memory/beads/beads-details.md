# Beads Details

Sources: https://github.com/gastownhall/beads, https://agentpatterns.ai/agent-design/beads-task-graph-agent-memory/, https://yuv.ai/blog/beads, https://www.dolthub.com/blog/2026-01-27-long-running-agentic-work-with-beads/, https://steve-yegge.medium.com/introducing-beads-a-coding-agent-memory-system-637d7d92514a

## Snapshot

Beads is a git-backed task graph and issue-tracking system designed as external memory for coding agents. Instead of storing arbitrary memories, it structures work as durable tasks, dependencies, notes, priorities, blockers, and state transitions.

Status: public open-source repository. License should be verified directly before adoption; secondary sources consistently describe it as free/open source.

## How It Works

Agents use the `bd` CLI to create, query, update, and relate work items. The core idea is that coding-agent memory should often be operational memory: what is being built, what is blocked, what was discovered, what depends on what, and what can be safely resumed later.

Beads stores its task graph in a repo-local `.beads/` directory, backed by a Dolt/SQLite-like database representation that can be committed to git. This gives agents queryable state and gives humans normal code-review and merge mechanics.

Key behaviors:

- create tasks/issues with IDs, priority, description, and acceptance criteria;
- add dependencies between tasks;
- log discovered work rather than losing it in chat history;
- let future sessions reconstruct active work from the task graph;
- keep memory branch-aware and versioned with the repository.

## Storage And Data Model

Beads is structured around task records and dependency graph edges rather than free-form semantic memory. Public writeups describe versioned JSONL or Dolt-powered state committed under `.beads/`. In practice, it should be treated as a repository artifact.

It is not primarily a vector database or RAG engine. Retrieval is through task/query structure and CLI usage. Semantic compaction appears in pattern writeups as summaries and issue fields rather than embedding-first recall.

## Integrations

Beads is agent-agnostic because agents can call a CLI. It is commonly discussed with Claude Code, Codex, Amp, and multi-agent workflows. It can be wrapped by skills/hooks/instructions telling the agent when to inspect and update the Beads graph.

## Selling Points

- Fits coding work more naturally than generic personal memory.
- Git-backed, branch-friendly, reviewable, mergeable.
- Gives agents a durable backlog and work graph.
- Reduces "plan soup" from ad hoc markdown files.
- Works with any CLI-capable agent, not tied to MCP only.

## Open/Closed Source And Target Users

Open-source: public repo, but license should be confirmed.

Target users: solo developers and teams using coding agents for multi-session work. Especially strong for long-horizon implementation, multi-agent task splitting, and branch-based workflows.

## Risks And Unknowns

- It does not solve semantic recall of arbitrary project facts unless those facts are written into tasks/notes.
- Agents need good instructions to create high-quality tasks with clear acceptance criteria.
- Humans may find the UX minimal compared with conventional issue trackers.
- Merge/conflict behavior needs evaluation in busy teams.
- If used alongside other memory systems, stale duplicate state can confuse agents.

