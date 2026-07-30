# LangMem / LangGraph Memory Details

Sources: https://langchain-ai.github.io/langmem/, https://langchain-ai.github.io/langgraph/concepts/memory/, https://docs.langchain.com/oss/python/langchain/short-term-memory, https://forum.langchain.com/t/agent-with-memory/1377, https://github.com/langchain-ai/langmem

## Snapshot

LangMem is LangChain's agent memory library, and LangGraph provides persistence, checkpoints, short-term thread memory, and long-term stores. Together they represent the framework-native memory stack for LangChain/LangGraph agents.

Status: open-source ecosystem with commercial LangSmith/LangGraph Platform options.

## How It Works

LangGraph divides memory into:

- short-term memory: thread-scoped state/checkpoints persisted during an interaction or agent workflow;
- long-term memory: cross-thread memory saved in a store and retrieved later;
- semantic memory: facts and knowledge;
- episodic memory: remembered experiences/examples;
- procedural memory: instructions/preferences/policies.

LangMem adds tools and utilities for creating, managing, searching, and updating memories. It can use store backends and embedding/search providers. LangGraph checkpointers preserve state across tool calls and interruptions.

## Storage And Data Model

Storage depends on configuration:

- checkpointers for graph/thread state;
- LangGraph stores for long-term memory;
- vector/embedding-backed search where configured;
- custom namespaces/scopes for user/application memory.

The data model is framework-native, not repo-file-native. Memories are records in stores and state channels, not markdown files by default.

## Integrations

Best fit is applications already built with LangChain or LangGraph. It integrates with LangSmith and platform deployment. It is not primarily an MCP local memory server, although MCP wrappers can call LangGraph apps.

## Selling Points

- Strong conceptual taxonomy: semantic, episodic, procedural.
- First-class persistence and checkpointing for agents.
- Good for production agent applications.
- Memory can be built into graph state transitions rather than bolted on.

## Open/Closed Source And Target Users

Open-source: yes for LangChain/LangGraph/LangMem libraries. Managed platform available.

Target users: developers building custom agents/apps in the LangChain ecosystem. For individual coding-agent users, this is more of a library/reference than a direct tool.

## Risks And Unknowns

- Requires adopting LangGraph architecture.
- Can be overkill for repo-local memory.
- Not inherently human-reviewable.
- Public forum posts show users still struggle with practical memory design and retrieval behavior.

