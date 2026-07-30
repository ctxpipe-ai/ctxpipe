# Local Agent Memory Research Index

Research date: 2026-05-24

Scope: local or coding-agent-oriented memory systems, plus widely used agent-memory frameworks that teams commonly compare against local tools. I intentionally ignored the current repo implementation and treated this as replacement-oriented market and architecture research.

## Corpus

Each solution has its own subfolder named by solution slug. Most solution folders contain:

- `<name>-details.md`: architecture, storage, integrations, licensing/open-source posture, target users, selling points, and risks.
- `<name>-sentiment.md`: public feedback and sentiment from accessible sources such as Reddit, Hacker News, Product Hunt, GitHub issues/discussions, docs comments, blog posts, and launch threads. X/Twitter was searched where surfaced by open web search, but most X content was not reliably accessible; I do not infer sentiment from inaccessible posts.
- `<name>-content.md`: what the system stores as memory, extraction semantics, prompt availability, and memory-soup controls.
- `<name>-deepdive.md`: extra-deep analysis for shortlisted solutions only.
- Some folders also contain follow-up research notes, such as integration design explorations.

Global synthesis files such as `leaderboard.md`, `themes.md`, `shortlist.md`, and `memory-type-table.md` stay in this top-level folder.

## Solutions Covered

1. AgentMemory (`agentmemory`, `agent-memory.dev`)
2. Mem0
3. OpenMemory by Mem0
4. Beads
5. memd
6. Dory
7. Basic Memory
8. Official MCP Knowledge Graph Memory Server
9. MCP Memory Service
10. MemoryGraph
11. Kage
12. Engram MCP
13. Hindsight
14. Letta / MemGPT
15. Zep
16. Graphiti
17. Cognee
18. LangMem / LangGraph memory
19. LlamaIndex Memory
20. Cline / Roo Memory Bank
21. Serena memories
22. Codebase-Memory MCP
23. ByteRover
24. SuperLocalMemory
25. Supermemory MCP

## High-Level Taxonomy

- Human-readable artifact memory: Beads, Dory, Basic Memory, ByteRover, Cline/Roo Memory Bank, Serena. These emphasize inspectability, git review, and low vendor lock-in.
- Local indexed MCP memory: AgentMemory, Kage, Engram, MemoryGraph, MCP Memory Service, Official MCP Memory, SuperLocalMemory. These expose memory as tools and usually combine structured records with search.
- General agent-memory platforms: Mem0, OpenMemory, Supermemory MCP, Letta, Zep, Graphiti, Cognee, Hindsight, LangMem/LangGraph, LlamaIndex. These are stronger as libraries/platforms and often need extra adaptation for repo-local coding workflows.
- Codebase structure memory: Serena and Codebase-Memory MCP focus on code intelligence and repository structure; their "memory" is less about personal preferences and more about durable code context.

## Early Takeaways For Later Design

- Trust and inspectability are recurring buying criteria. Users repeatedly ask where memory is stored, whether it is human-readable, whether it can be versioned, and how secrets are filtered.
- Pure vector memory is viewed as insufficient for coding agents. Public feedback favors hybrid retrieval, explicit task/state structures, knowledge graphs, or file hierarchies.
- Teams want memory to survive session resets, branch switches, compaction, and tool switching. Repo-local and branch-aware designs are especially relevant for coding.
- Memory quality depends as much on write discipline as retrieval. Stale notes, noisy captures, and unreviewed autonomous writes are common failure modes.
- The market is noisy. There are many launch-post projects with impressive benchmark claims but limited independent sentiment. Treat benchmark claims as leads, not proof.
