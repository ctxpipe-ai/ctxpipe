# Zep Details

Sources: https://www.getzep.com/, https://help.getzep.com/, https://github.com/getzep/zep, https://help.getzep.com/graphiti/graphiti/overview, https://github.com/getzep/graphiti

## Snapshot

Zep is a memory layer for AI agents focused on conversation memory, user facts, and graph-based long-term context. It provides managed and open-source components and is closely related to Graphiti, Zep's temporal knowledge graph framework.

Status: open-source repos plus managed product. Current product boundaries and licenses should be verified because Zep/Graphiti have evolved over time.

## How It Works

Zep ingests conversations and business/user data, extracts facts, builds memory, and retrieves relevant context for agents. Modern Zep positioning emphasizes a knowledge graph with temporal awareness, enabling memory that knows relationships and when facts were valid.

The memory workflow:

- add messages or data;
- extract facts/entities/edges;
- update graph memory;
- search or retrieve context relevant to a session/user;
- inject context into agent prompts.

## Storage And Data Model

Zep's storage model differs between product and self-host/open-source setups. Graphiti documentation shows temporal graph structures with entities, episodes, edges, and fact history. Older Zep self-host versions used Postgres/vector search and service components; current adoption needs checking against the latest docs.

## Integrations

Zep integrates with LangChain, LangGraph, Python/JS SDKs, and agent apps. It is designed for app developers rather than specifically for Claude Code or repo-local memory, though it can be used behind an MCP bridge.

## Selling Points

- Mature agent-memory brand.
- Temporal knowledge graph is stronger than flat vector memory.
- Good for user/session memory in production apps.
- Useful search/context assembly APIs.

## Open/Closed Source And Target Users

Open-source: public repos exist. Managed platform available.

Target users: teams building AI products and agents with user/session memory. For individual local coding agents, Zep may be too product/backend-oriented unless self-hosted or used through Graphiti.

## Risks And Unknowns

- Product/open-source boundaries have changed; verify before designing against it.
- Requires infrastructure and schema decisions.
- Not naturally repo-local, branch-aware, or human-editable.
- Graph extraction quality and temporal conflict resolution must be evaluated on coding data.

