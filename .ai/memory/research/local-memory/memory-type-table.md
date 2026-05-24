# Memory Type Classification

Research date: 2026-05-24

This table classifies the researched solutions by the actual kind of memory they store: coding knowledge, generic knowledge, work-management state, behavioral learning, or framework/app memory.

| Solution | Primary memory type | Coding-knowledge memory? | What it actually stores |
|---|---|---:|---|
| Beads | Work-management | Partial | Tasks, blockers, dependencies, status, discovered follow-up work, ready/claimed/closed items |
| Cline / Roo Memory Bank | Coding knowledge + work state | Yes | Project brief, product context, active context, system patterns, tech context, progress |
| ByteRover | Coding knowledge | Yes | Project patterns, decisions, preferences, conventions, entities, skills, context-tree facts |
| AgentMemory | Coding knowledge + session traces | Yes | Tool/session observations, file histories, decisions, patterns, project profiles, handoffs |
| memd | Coding knowledge + work state | Yes | Decisions, patterns, errors, schemas, constraints, solutions, checkpoints, progress, tasks |
| Serena | Codebase knowledge | Yes | Project notes plus code symbols, references, architecture/convention notes |
| Codebase-Memory MCP | Codebase knowledge | Yes | Codebase structure, dependencies, decisions, implementation patterns |
| Basic Memory | Generic knowledge graph | Adaptable | Markdown entities, observations, relations, notes, decisions, requirements, facts |
| Dory | Generic/project knowledge | Adaptable | Active context, decisions, people, project state, markdown corpus links |
| OpenMemory | Generic/coding preferences | Partial | User preferences, implementation knowledge, coding style, project facts via Mem0 |
| Mem0 | Generic personal/agent knowledge | Partial | User facts, preferences, plans, experiences, assistant/user memories, procedural memories |
| Hindsight | Behavioral learning | Partial | Corrections, feedback, lessons learned, useful/failed prior behavior |
| SuperLocalMemory | Generic + behavioral patterns | Partial | Facts, entities, relationships, preferences, workflow patterns, provenance/trust scores |
| MemoryGraph | Generic graph knowledge | Partial | Nodes, relationships, observations, patterns, cross-session facts |
| Kage | Generic graph knowledge | Partial | Entities, observations, relationships |
| MCP Memory Service | Generic semantic memory | Partial | Semantic memory records, embeddings, metadata, likely facts/preferences/project context |
| Official MCP Memory Server | Generic graph knowledge | No | Entities, relations, observations |
| Engram MCP | Generic memory | No/unknown | Persistent memory text/metadata; schema unclear |
| Supermemory MCP | Generic personal knowledge | No/partial | User memories, facts, saved context, cross-client assistant memories |
| Letta / MemGPT | Generic agent state | No/partial | Core memory blocks, user profile, persona, scratchpad, archival memory, conversation recall |
| Zep | Generic app/user knowledge | No/partial | User facts, entities, episodes, observations, thread/user summaries, temporal graph facts |
| Graphiti | Generic temporal graph | No/partial | Episodes, entities, facts, relationships, temporal validity, communities |
| Cognee | Generic document/data knowledge | No/partial | Source data, chunks, entities, relationships, summaries, graph/vector records |
| LangMem / LangGraph | Generic agent memory taxonomy | No/partial | Semantic facts, episodic examples, procedural instructions, thread checkpoints |
| LlamaIndex Memory | Generic app/chat memory | No/partial | Static memory, extracted facts, vectorized chat/message batches |

## Shortlist By Memory Type

Strongest actual coding-knowledge candidates:

- Cline / Roo Memory Bank
- ByteRover
- AgentMemory
- memd
- Serena
- Codebase-Memory MCP

Strong work-management candidate:

- Beads

Most adaptable generic knowledge-memory candidates:

- Basic Memory
- Dory
- Mem0 / OpenMemory
- SuperLocalMemory

Key interpretation: Beads is highly tailored for coding agents, but it is primarily a work-management memory layer rather than a coding-knowledge memory layer. It should be considered for task/work graph continuity, not as the whole memory system.

