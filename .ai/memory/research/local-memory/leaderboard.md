# Local Agent Memory Sentiment Leaderboard

Research date: 2026-05-24

This ranking synthesizes the 25 `*-sentiment.md` files in this folder. "Best" means strongest positive public sentiment plus the most credible evidence base. It does not mean "best architecture for ctxpipe" yet. Lower-ranked projects are often not disliked; many simply have sparse independent feedback.

## Method

Ranking factors:

- Positive user feedback and concrete practitioner reports.
- Breadth and independence of sources.
- Relevance of the feedback to coding-agent or local-memory workflows.
- Severity of recurring concerns.
- Confidence level recorded in each sentiment file.

## Ranking

| Rank | Solution | Sentiment | Confidence | Why It Lands Here |
|---:|---|---|---|---|
| 1 | [Beads](./beads/beads-sentiment.md) | Very positive | Medium-high | Strongest practitioner reports for coding-agent continuity. Users describe concrete wins across compaction, task resumption, and discovered-work tracking. |
| 2 | [Letta / MemGPT](./letta-memgpt/letta-memgpt-sentiment.md) | Strong positive, with complexity caveat | Medium-high | Widely respected memory hierarchy and mature project. Criticism is mostly about framework weight, not the memory concept. |
| 3 | [Mem0](./mem0/mem0-sentiment.md) | Positive but mixed | Medium-high | Clear default comparison point with broad recognition. Critiques around graph availability, cost, and fact-vs-pattern memory keep it below the top two. |
| 4 | [Basic Memory](./basic-memory/basic-memory-sentiment.md) | Positive | Medium | Strong local-first/Markdown trust signal. Some agent-write-quality friction, but the sentiment is consistently favorable. |
| 5 | [Cline / Roo Memory Bank](./cline-roo-memory-bank/cline-roo-memory-bank-sentiment.md) | Positive and pragmatic | Medium | Users like the simple markdown continuity pattern. Weaknesses are known and accepted: stale files, manual discipline, limited search. |
| 6 | [ByteRover](./byterover/byterover-sentiment.md) | Positive, launch-heavy | Medium | Very relevant to coding agents, with visible developer-tooling interest. Ranked below simpler proven patterns because much feedback is still promotional/early. |
| 7 | [Zep](./zep/zep-sentiment.md) | Generally positive | Medium | Seen as a serious production memory option, especially for app builders. Less local/coding-specific, but sentiment is credible. |
| 8 | [Graphiti](./graphiti/graphiti-sentiment.md) | Positive technical interest | Medium | Temporal graph memory is well regarded. Feedback is more architecture interest than long-term coding-agent use. |
| 9 | [LangMem / LangGraph Memory](./langmem-langgraph/langmem-langgraph-sentiment.md) | Respectful but complex | Medium | Strong framework-native taxonomy and checkpointing. Users still struggle with practical memory design. |
| 10 | [Supermemory MCP](./supermemory-mcp/supermemory-mcp-sentiment.md) | Positive, with privacy caveat | Medium | Good launch energy and MCP UX. Cloud/product-backed storage limits appeal for local codebase memory. |
| 11 | [Cognee](./cognee/cognee-sentiment.md) | Cautiously positive | Medium | Knowledge-graph app memory gets interest, but users want proof that the extra machinery pays off. |
| 12 | [AgentMemory](./agentmemory/agentmemory-sentiment.md) | Mostly positive early signal | Medium-low | Strong launch framing and local-first appeal. Needs more independent long-term reports. |
| 13 | [Serena](./serena/serena-sentiment.md) | Positive adjacent signal | Medium-low | Well liked for code intelligence; memory itself is less discussed and secondary. |
| 14 | [LlamaIndex Memory](./llamaindex-memory/llamaindex-memory-sentiment.md) | Mildly positive in-framework | Medium-low | Useful memory primitives for LlamaIndex users, but little standalone coding-agent sentiment. |
| 15 | [Hindsight](./hindsight/hindsight-sentiment.md) | Positive concept, early adoption | Low-medium | Feedback-first memory is compelling, but public usage as a coding-agent memory layer is thin. |
| 16 | [SuperLocalMemory](./superlocalmemory/superlocalmemory-sentiment.md) | Positive launch interest | Low-medium | Privacy/security framing resonates. Ambitious claims and limited independent reports keep it mid-lower. |
| 17 | [MCP Memory Service](./mcp-memory-service/mcp-memory-service-sentiment.md) | Generally positive but noisy | Low-medium | SQLite/MCP memory demand is real, but canonical project identity and maintenance signals need verification. |
| 18 | [Official MCP Knowledge Graph Memory Server](./official-mcp-memory/official-mcp-memory-sentiment.md) | Mixed but respected | Medium | Useful reference server, but users hit path/update issues and see it as primitive for serious work. |
| 19 | [OpenMemory](./openmemory/openmemory-sentiment.md) | Promising but thin | Low | Mem0-backed MCP story is attractive, but independent public feedback is sparse. |
| 20 | [Dory](./dory/dory-sentiment.md) | Positive design alignment, sparse evidence | Low | Markdown-first local design fits user preferences, but there are few visible third-party reports. |
| 21 | [memd](./memd/memd-sentiment.md) | Interesting but unproven | Low | Strong structured model, but public sentiment is not established and hosted/self-hosted boundaries need clarity. |
| 22 | [MemoryGraph](./memorygraph/memorygraph-sentiment.md) | Plausible but sparse | Low | Graph-memory concept is attractive, but independent usage evidence is minimal. |
| 23 | [Kage](./kage/kage-sentiment.md) | Plausible but sparse | Low | Local-only graph memory should appeal, but public adoption evidence is thin. |
| 24 | [Codebase-Memory MCP](./codebase-memory-mcp/codebase-memory-mcp-sentiment.md) | Too little signal | Very low | Highly relevant concept, but no meaningful independent feedback was found. |
| 25 | [Engram MCP](./engram-mcp/engram-mcp-sentiment.md) | Too little signal | Very low | Lightweight MCP memory candidate, but public sentiment and architecture clarity are weakest in the corpus. |

## Tier View

### Strongest Positive Sentiment

- Beads
- Letta / MemGPT
- Mem0
- Basic Memory
- Cline / Roo Memory Bank

### Promising But Still Early Or Domain-Limited

- ByteRover
- Zep
- Graphiti
- LangMem / LangGraph Memory
- Supermemory MCP
- Cognee
- AgentMemory
- Serena

### Interesting, But Needs More Proof

- LlamaIndex Memory
- Hindsight
- SuperLocalMemory
- MCP Memory Service
- Official MCP Knowledge Graph Memory Server
- OpenMemory
- Dory
- memd
- MemoryGraph
- Kage

### Too Sparse To Judge

- Codebase-Memory MCP
- Engram MCP

## Important Caveat

This leaderboard measures public sentiment strength, not design fit. For ctxpipe's eventual memory design, the most useful candidates may not be the top-ranked products. Beads, Basic Memory, Cline/Roo Memory Bank, ByteRover, AgentMemory, and SuperLocalMemory are especially relevant because they speak directly to coding-agent continuity, local ownership, inspectability, and context persistence.

