# AgentMemory Deep Dive

Research date: 2026-05-24

## Sources

- Landing page: https://www.agent-memory.dev/
- GitHub repository: https://github.com/rohitg00/agentmemory
- README: https://github.com/rohitg00/agentmemory/blob/main/README.md
- Changelog: https://github.com/rohitg00/agentmemory/blob/main/CHANGELOG.md
- AGENTS.md surfaced by search: https://github.com/rohitg00/agentmemory/blob/main/AGENTS.md
- Product Hunt launch: https://www.producthunt.com/products/agent-memory-dev
- Reddit launch discussion: https://www.reddit.com/r/ChatGPT/comments/1sfr0jy/i_built_agentmemory_your_ai_coding_agent_now/
- LangLabs package summary: https://langlabs.io/rohitg00/agentmemory
- Local prior research: [details](./agentmemory-details.md), [content](./agentmemory-content.md), [sentiment](./agentmemory-sentiment.md)

## Executive Read

AgentMemory is the most ambitious "full runtime" on the shortlist. It is a local memory engine for coding agents with hooks, an MCP server, a REST API, a viewer, session replay, hybrid retrieval, graph relationships, consolidation, audit/governance tools, and broad client support.

Its central bet is auto-capture: every meaningful coding-agent lifecycle event can become a raw observation, later compressed into useful memories. That is powerful because agents often forget to call "remember". It is also risky because auto-capture can collect secrets, transient debugging noise, and wrong assumptions unless redaction and consolidation are excellent.

For ctxpipe, AgentMemory is most valuable as a lifecycle architecture reference: raw observations, compressed episodes, semantic memories, procedural patterns, pinned context, provenance, viewer/replay, and audit/delete. It is less obviously the right exact shape for a repo-native memory system because the runtime is broad and complex.

## What It Is

AgentMemory is a persistent memory layer for AI coding agents. It targets:

- Claude Code;
- Codex CLI;
- Cursor;
- Gemini CLI;
- OpenCode;
- Cline;
- Roo Code;
- Goose;
- Aider;
- Claude Desktop;
- any MCP or REST-capable client.

It runs as a local service and exposes:

- hooks/plugins for supported agents;
- MCP tools;
- REST endpoints;
- local viewer;
- import/export;
- governance/delete/audit;
- session replay.

Primary category: local-first coding-agent memory runtime.

Secondary categories:

- session trace store;
- hybrid search engine;
- agent coordination layer;
- work/action graph;
- memory governance/audit system.

## Implementation And Language

Observed implementation:

- main language: TypeScript;
- package channel: npm packages under `@agentmemory/*`;
- CLI command via `npx @agentmemory/agentmemory`;
- Node.js >= 20;
- built on the `iii` engine;
- Apache-2.0 license surfaced in README;
- local server default;
- viewer on localhost;
- standalone MCP mode available.

Repository/source stats surfaced by README:

- 118 source files;
- about 21,800 LOC;
- 950+ tests;
- 123 functions;
- 34 KV scopes.

Storage/runtime claims:

- zero external databases;
- no Redis, Kafka, Postgres, Qdrant required for the default local flow;
- state handled through iii engine primitives and local state;
- README comparison names SQLite plus iii-engine;
- README later describes iii KV State plus in-memory vector index as replacing SQLite/Postgres+pgvector in the traditional stack.

The exact internal persistence should be checked in code before adoption. The public story is clear enough for architecture analysis: one local runtime, not multiple external infra services.

## High-Level Architecture

AgentMemory is organized around three major primitives:

1. Hooks/capture
2. Recall/search
3. Consolidation/lifecycle

### Capture

Agent integrations fire lifecycle events into the memory pipeline. Public docs list captures from:

- `SessionStart`;
- `UserPromptSubmit`;
- `PreToolUse`;
- `PostToolUse`;
- `PostToolUseFailure`;
- `PreCompact`;
- `SubagentStart`;
- `SubagentStop`;
- `Stop`;
- `SessionEnd`.

This means memory can capture:

- project path;
- session id;
- user prompt, privacy-filtered;
- file access patterns;
- tool input/output;
- failed tool context;
- compaction context;
- subagent lifecycle;
- end-of-session summaries.

### Recall

AgentMemory performs hybrid retrieval:

- BM25 lexical search;
- vector search;
- graph traversal;
- Reciprocal Rank Fusion;
- local/on-device reranking according to landing-page language;
- session diversification.

At session start, public docs describe loading:

- project profile;
- top concepts;
- relevant files;
- patterns;
- hybrid search results;
- a token-budgeted context, default around 2000 tokens in README.

### Consolidation

README describes a 4-tier memory consolidation model:

| Tier | Meaning |
|---|---|
| Working | Raw observations from tool use. |
| Episodic | Compressed session summaries. |
| Semantic | Extracted facts and patterns. |
| Procedural | Workflows and decision patterns. |

It claims:

- decay over time;
- frequent-access strengthening;
- stale-memory eviction;
- contradiction detection/resolution.

### API Surface

Public API surface includes:

- 50+ MCP tools depending on full server versus shim path;
- MCP resources;
- prompts;
- skills;
- REST twins for MCP tools;
- local viewer.

Core/extended tools surfaced in README include:

- `memory_recall`;
- `memory_smart_search`;
- `memory_save`;
- `memory_patterns`;
- `memory_file_history`;
- `memory_sessions`;
- `memory_timeline`;
- `memory_profile`;
- `memory_export`;
- `memory_relations`;
- `memory_graph_query`;
- `memory_consolidate`;
- `memory_audit`;
- `memory_governance_delete`;
- `memory_snapshot_create`;
- `memory_action_create`;
- `memory_action_update`;
- `memory_frontier`;
- `memory_next`;
- `memory_lease`;
- `memory_signal_send`;
- `memory_signal_read`;
- `memory_checkpoint`;
- `memory_mesh_sync`;
- `memory_sentinel_create`;
- `memory_sentinel_trigger`;
- `memory_sketch_create`;
- `memory_sketch_promote`;
- `memory_crystallize`;
- `memory_facet_tag`;
- `memory_facet_query`;
- `memory_verify`.

Public prompts:

- `recall_context`;
- `session_handoff`;
- `detect_patterns`.

## Memory Content Model

AgentMemory stores several layers:

- raw hook observations;
- compressed observations;
- session timelines;
- semantic memories;
- explicit user/agent-saved insights;
- decisions;
- patterns;
- file histories;
- project profiles;
- recurring patterns;
- relationship graph entries;
- audit rows;
- governance/delete records;
- snapshots;
- action/work items;
- leases;
- inter-agent signals;
- sentinels/watchers;
- ephemeral action graphs or sketches;
- crystallized action chains;
- facet tags;
- optional pinned slots.

The public content model is broader than strict "coding knowledge". It spans:

- coding facts;
- session traces;
- project intelligence;
- procedural workflows;
- operational state;
- team/multi-agent coordination.

## Examples Of What It Stores

From README demo framing:

- JWT auth setup;
- N+1 query fix;
- rate limiting implementation;
- choice of `jose` over `jsonwebtoken` for Edge compatibility;
- auth middleware path;
- test coverage around token validation.

Possible semantic memory:

```json
{
  "type": "decision",
  "project": "ctxpipe",
  "content": "Use jose for JWT middleware because it works in Edge-compatible runtimes.",
  "source": "session:2026-05-24-auth",
  "files": ["src/middleware/auth.ts"],
  "confidence": 0.82
}
```

Possible file history memory:

```json
{
  "file": "src/middleware/auth.ts",
  "observations": [
    "Token validation tests cover expired access tokens.",
    "Rate-limit middleware runs after auth middleware."
  ]
}
```

Possible procedural memory:

```json
{
  "type": "procedural",
  "content": "When debugging N+1 query regressions, inspect resolver batching first, then run the repository query-count test.",
  "evidence": ["session timeline", "test failure", "successful fix"]
}
```

Possible action graph:

```json
{
  "action": "replace memory layer",
  "blockedBy": ["finish shortlist deep dives"],
  "next": ["draft architecture proposal"],
  "lease": "agent-session-abc"
}
```

## Extraction And Prompt Availability

I did not find full public bodies for the internal extraction/consolidation prompts.

Publicly visible pieces:

- hook names and what they capture;
- MCP prompt names;
- 4-tier consolidation model;
- optional LLM provider configuration;
- default no-op LLM provider, meaning LLM-backed compression/summarization is disabled unless configured;
- privacy filtering for user prompts;
- secret stripping claims;
- `memory_save` for explicit insights/decisions/patterns;
- `memory_patterns` and `detect_patterns` for recurring patterns.

This is enough to understand the intended pipeline but not enough to audit extraction criteria.

Important design implication:

AgentMemory should be evaluated by reading the repository source before adopting extraction behavior. The product docs describe the architecture and tool surface, but durable-memory quality depends on exact prompts, filters, schemas, and consolidation logic.

## Retrieval And Use Path

Common use path:

1. Start local server:

```text
npx @agentmemory/agentmemory
```

2. Connect a client/agent:

- Claude Code plugin;
- Codex plugin;
- Cursor MCP;
- Cline/Roo MCP;
- generic REST.

3. Agent hooks stream observations into local memory.
4. At session start, AgentMemory generates/retrieves relevant context.
5. Agent receives a compact memory context.
6. During work, tool calls and prompts create more observations.
7. Consolidation promotes useful observations into higher-level memories.
8. User can inspect in viewer/replay and export/delete as needed.

Standalone MCP path:

- can run `npx -y @agentmemory/agentmemory mcp`;
- shim exposes a smaller local tool set if no full server is reachable;
- full tool surface requires a running server via `AGENTMEMORY_URL`.

## Memory Soup Controls

AgentMemory's anti-soup story is explicit and ambitious.

Controls:

- raw observations are not the final memory layer;
- 4-tier consolidation separates raw, episodic, semantic, procedural memory;
- BM25/vector/graph streams avoid a single undifferentiated vector bucket;
- session diversification prevents one session from dominating recall;
- decay and strengthening model claims;
- auto-forgetting/TTL/importance eviction claims;
- contradiction detection claims;
- audit trail for operations;
- governance delete;
- export/import;
- viewer/replay;
- `memory_verify` provenance tracing;
- snapshots;
- project profiles;
- facet tags;
- pinned slots/categories;
- file-specific histories.

Remaining concerns:

- auto-capture can create more raw material than the consolidator can cleanly judge;
- if compression is wrong, later semantic memories can become durable misinformation;
- if secret filtering misses cases, sensitive data can become persistent;
- contradiction detection is hard and needs proof;
- full tool surface is large enough to increase operational/security review burden.

## Architecture Choices

### Auto-Capture Hooks

Benefits:

- agents do not need to remember to call memory tools;
- captures failures and tool outputs that manual notes miss;
- supports rich session replay;
- creates evidence for provenance.

Costs:

- privacy risk;
- secret leakage risk;
- noise risk;
- more background behavior to trust;
- hook support varies by agent.

### Local Runtime Instead Of External Databases

Benefits:

- lower setup burden than Postgres/Qdrant/Neo4j;
- good solo-developer fit;
- easier privacy story;
- one process by default.

Costs:

- runtime is still non-trivial because of iii-engine;
- debugging state requires understanding AgentMemory internals;
- migration/backup behavior must be verified;
- team/multi-device sync can become harder.

### Hybrid Retrieval

Benefits:

- lexical exactness for file names and symbols;
- vector similarity for semantic paraphrases;
- graph traversal for relationships;
- RRF can combine strengths.

Costs:

- each stream can fail differently;
- graph extraction quality is critical;
- vector models introduce optional dependencies;
- retrieval benchmarks may not reflect coding-agent correctness.

### Lifecycle And Governance

Benefits:

- memory evolves rather than only accumulates;
- delete/export/audit addresses trust;
- snapshots enable rollback/diff;
- provenance helps inspect why something was recalled.

Costs:

- many governance APIs increase complexity;
- users need good defaults;
- "auto-forget" must not delete rare but critical knowledge.

## Benchmarks And Evidence

Public benchmark claims in README:

- coding-agent-life-v1 in-house corpus: top-5 hit rate 15/15, p50 latency 14 ms for hybrid, precision advantage over grep baseline;
- LongMemEval-S: AgentMemory reports R@5 95.2 percent, R@10 98.6 percent, MRR 88.2 percent;
- BM25-only fallback is reported lower on LongMemEval-S;
- token-savings table claims large reduction versus pasting full context or LLM summaries;
- local embedding model named: `all-MiniLM-L6-v2`.

Interpretation:

- The benchmark story is stronger than many young tools because the README points to benchmark files and a reproducibility harness.
- The coding-agent-life-v1 corpus is in-house, so it should be treated as product evidence, not independent validation.
- LongMemEval-S is useful but does not prove coding-agent task quality.
- Need to run local reproduction before using numbers as design proof.
- Retrieval accuracy alone does not prove stale/contradictory memories are handled safely.

Public adoption/sentiment:

- strong launch energy;
- high GitHub star count surfaced during research;
- Product Hunt and Reddit discussion show real interest;
- questions focus on relevance decay, sensitive data, and setup rather than rejecting the premise.

Confidence: medium-low to medium.

## Pros

- Directly targets coding agents.
- Local-first default.
- Broad agent compatibility.
- Hooks solve the "agent forgot to save memory" problem.
- MCP and REST both available.
- Viewer/replay improves trust.
- Hybrid retrieval is stronger than pure markdown or pure vectors.
- 4-tier consolidation is a useful architecture.
- Audit/export/delete/provenance are first-class.
- File history and project profiles are highly relevant to coding.
- Action graph, leases, signals, and sentinels are promising for multi-agent work.
- Apache-2.0 license is favorable.

## Cons

- Very broad product surface.
- iii-engine dependency adds conceptual and operational weight.
- Auto-capture is privacy-sensitive.
- Extraction/consolidation prompts were not fully found.
- Secret filtering claims need direct audit.
- Benchmark claims need reproduction.
- Hook behavior differs by client.
- Full MCP tool surface can overwhelm agents and users.
- Team features need access-control and data-boundary review.
- Potential overlap with existing repo docs, task trackers, and agent rules.

## Gaps And Missing Facets

To audit before adoption:

- exact schemas for observations, semantic memories, relationships, snapshots;
- exact redaction rules and tests;
- exact prompts used for compression/consolidation/pattern detection;
- migration and backup story;
- project/repo/branch/worktree scoping;
- how contradictions are represented and resolved;
- how stale memories are deleted or archived;
- whether all state is truly local by default;
- how plugins update across versions;
- whether viewer exposes sensitive data safely;
- how memory injection is explained to the agent/user;
- memory poisoning defenses;
- team sharing and ACL model.

## Fit For Individuals

Strong for heavy agent users who want automatic capture and are comfortable running a local service.

Best individual use cases:

- agent switching;
- session replay;
- remembering debugging history;
- file-specific histories;
- automatic context injection after session start;
- local benchmark experimentation.

Possible friction:

- background server;
- plugin setup;
- port conflicts;
- needing to understand the viewer and governance controls;
- trust in auto-capture.

## Fit For Teams

Promising but needs deeper audit.

Team-relevant features:

- shared memory server possibilities;
- snapshots;
- team share/feed tools;
- leases;
- signals;
- action frontiers;
- provenance/audit.

Team risks:

- sensitive project data;
- ACL boundaries;
- multi-user conflict handling;
- plugin/version drift;
- noisy shared memory;
- no guarantee team facts are reviewed before recall.

## Security And Privacy

Positive:

- local-first/default self-host story;
- no external DB required;
- API keys/secrets stripping is claimed;
- `<private>` tags stripping is claimed;
- governance/delete/export tools;
- audit trail.

Risks:

- hook capture sees prompts, file access patterns, tool inputs/outputs, and errors;
- tool outputs can include secrets;
- shell/test outputs can include tokens;
- local viewer can expose memory on localhost;
- remote deployments need HMAC/transport/backup review;
- auto-injection can act like hidden prompt context if not transparent.

Recommended mitigation if borrowing design:

- make redaction rules explicit and testable;
- keep auto-captured candidates in review before promotion;
- store raw observations separately from durable facts;
- show "why recalled" provenance;
- allow per-project disablement and ignored paths;
- never silently inject sensitive memories.

## Design Lessons For ctxpipe

High-value ideas to copy:

- event/raw observation layer;
- compressed episodic layer;
- semantic/project fact layer;
- procedural/pattern layer;
- provenance and verification;
- viewer or simple inspection UI;
- export/delete/audit;
- file-specific memory history;
- project profile;
- hybrid retrieval as secondary index;
- session handoff prompt;
- explicit action/work graph ideas.

Ideas to avoid or constrain:

- auto-saving everything directly as durable memory;
- enormous tool surface in the default agent context;
- hidden memory injection without source display;
- heavy background runtime before simpler source-of-truth files prove value;
- benchmark-driven claims without repo-specific evaluation.

## Bottom Line

AgentMemory is the richest local coding-agent memory runtime on the shortlist. It is most useful as a reference for capture, consolidation, provenance, replay, and lifecycle. Its main risk is the same as its main strength: automatic capture. A ctxpipe design should borrow the layered memory model but keep auto-capture reviewable, scoped, and visibly connected to human-readable project memory.

