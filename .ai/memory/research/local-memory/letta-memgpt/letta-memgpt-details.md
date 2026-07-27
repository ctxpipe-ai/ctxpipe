# Letta / MemGPT Details

Sources: https://docs.letta.com/, https://github.com/letta-ai/letta, https://arxiv.org/abs/2310.08560, https://docs.letta.com/guides/agents/memory, https://news.ycombinator.com/item?id=37869760, https://www.reddit.com/r/LocalLLaMA/comments/171o39q/memgpt_towards_llms_as_operating_systems/

## Snapshot

Letta, formerly MemGPT, is a stateful agent framework built around explicit memory management. It models agents as having limited context, editable core memory, and external archival memory. It is broader than coding-agent memory, but it deeply influenced the agent-memory space.

Status: open-source framework plus managed product. The GitHub project is public.

## How It Works

MemGPT introduced an operating-system-inspired hierarchy:

- in-context memory: what is currently inside the model window;
- core memory: small editable persona/user/task state kept in context;
- archival memory: larger out-of-context store searched and paged in when needed;
- recall memory: conversation/event history.

The agent has tools to read, write, and move data between memory tiers. Letta's current docs keep this memory-centric agent model, exposing agent state, memory blocks, tools, and persistence through APIs.

## Storage And Data Model

Letta agents have memory blocks such as human/persona/context fields and can connect to archival data stores. Deployment can use local or managed infrastructure. Storage is more agent-state-centric than repo-file-centric.

## Integrations

Letta exposes APIs, agent runtime, ADE/UI, tools, and integrations for building persistent agents. It is not a drop-in `.ai/memory` repo artifact, but it can host agents that remember across sessions.

## Selling Points

- Strong conceptual model for bounded context and explicit memory management.
- Mature open-source lineage.
- Good fit for stateful long-running agents.
- Clear separation of working memory and archival memory.

## Open/Closed Source And Target Users

Open-source: yes for framework. Managed platform exists.

Target users: agent builders, researchers, and teams building custom persistent agents. For individual coding-agent users, it may be heavier than an MCP memory server.

## Risks And Unknowns

- Adoption may require building on Letta's runtime rather than layering memory onto existing coding agents.
- More framework commitment than file/MCP memory.
- The mental model is powerful but can be overkill for simple project memory.
- Coding workflow concepts like branches and task graphs are not the central abstraction.

