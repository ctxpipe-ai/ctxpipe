# AgentMemory Content Model

Sources: https://www.agent-memory.dev/, https://github.com/rohitg00/agentmemory, https://github.com/rohitg00/agentmemory/blob/main/CHANGELOG.md

## What It Stores

AgentMemory stores a multi-layer record of coding-agent work:

- raw lifecycle observations from hooks such as session start, prompts, tool calls, and stop events;
- compressed observations generated from those raw events;
- semantic memories promoted out of the observation stream;
- explicit saved insights, decisions, and patterns via `memory_save`;
- session metadata and chronological timelines;
- file histories and observations about specific files;
- recurring patterns detected across sessions;
- relationship-graph entries;
- audit/governance rows for deletes and retention actions;
- optional pinned memory slots.

The README also describes "sketches" or ephemeral action graphs, crystallized action chains, facet tags, checkpoints, sentinels, inter-agent messages, and project profiles. Those expand memory beyond facts into work traces, operational state, and agent coordination metadata.

## Semantics / Types It Looks For

The visible public surface suggests these memory themes:

- `insight`;
- `decision`;
- `pattern`;
- file-specific observations;
- recurring behavior patterns;
- project concepts;
- action chains;
- relationship-graph facts;
- session handoff material;
- pending items;
- tool guidelines;
- user preferences;
- project context;
- self notes.

The optional `AGENTMEMORY_SLOTS` setting names pinned slot categories: persona, user preferences, tool guidelines, project context, guidance, pending items, session patterns, and self notes.

## Extraction Prompt

I did not find the full extraction/consolidation prompt in public search results. The repository README exposes MCP prompt names rather than their bodies:

- `recall_context`;
- `session_handoff`;
- `detect_patterns`.

Prompt link: https://github.com/rohitg00/agentmemory#readme

The README states that every hook event becomes a compressed observation and that hourly sweeps compress raw observations into semantic memories. It also notes that when LLM-based observation compression is enabled, `PostToolUse` can call the configured LLM provider to compress observations.

## How It Manages Memory Soup

AgentMemory has one of the strongest explicit anti-soup stories in the corpus:

- raw observations are not treated as final memories;
- consolidation sweeps compress raw observations into semantic memories;
- duplicate memories are merged;
- stale rows decay using retention scoring;
- deletes emit audit rows;
- hybrid retrieval uses BM25, vector, and graph streams rather than one unbounded vector bucket;
- facet tags and graph relations provide additional structure;
- provenance tools such as `memory_verify` help trace where memories came from;
- project profiles and file histories provide scoped views instead of dumping everything into startup context;
- optional pinned slots separate always-visible stable guidance from searchable historical memory.

The main unresolved question is write quality: public docs describe the pipeline, but the actual extraction criteria and prompts were not visible in this pass.

## Notes For ctxpipe

AgentMemory is valuable for its lifecycle split: raw capture, compressed observation, semantic memory, pinned slot, and audit/provenance. The design risk is silent auto-capture; ctxpipe should copy the layering idea but make extraction criteria reviewable.

