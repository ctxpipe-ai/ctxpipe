# Shortlist: Local Open-Source Coding-Knowledge Memory

Research date: 2026-05-24

Selection criteria:

- Open source, source-available, or public/open pattern.
- Local-first or clearly self-hostable.
- Focused on coding knowledge, codebase knowledge, or project implementation memory.
- Positive or optimistic public sentiment, including promising tools with limited data.

## Core Shortlist

| Solution | Why It Passes | Memory Focus | Sentiment | License / Source Signal | Redistribute In Competing Product? | Main Caveat |
|---|---|---|---|---|---:|---|
| [Cline / Roo Memory Bank](./cline-roo-memory-bank/cline-roo-memory-bank-content.md) | Public/open pattern, local markdown, explicitly coding-project memory, positive pragmatic sentiment | Project brief, product context, active context, system patterns, tech context, progress | Positive | Roo repo Apache-2.0; Cline docs/prompt pattern public | Mostly yes | Roo repo can be reused under Apache-2.0; reimplementing the pattern is fine, but copying Cline docs/prompt text wholesale needs docs-license review. Manual discipline; no built-in search, dedup, or decay |
| [AgentMemory](./agentmemory/agentmemory-content.md) | Open-source, local-first runtime, directly targets Claude/Codex/Cursor-style coding agents | Session/tool observations, file histories, decisions, patterns, project profiles, handoffs | Positive early signal | Apache-2.0 in repo/package metadata | Yes | Auto-capture needs redaction/review; extraction prompts not fully public |
| [Serena](./serena/serena-content.md) | Open-source local MCP coding toolkit, project memories paired with semantic code intelligence | Project memories, conventions, architecture notes, symbols, references | Positive adjacent signal | MIT in repo | Yes | Memory is secondary; not a full memory lifecycle system |

## Conditional / Needs Code Audit

| Solution | Why It Is Close | Why It Misses Core Shortlist For Now | License / Source Signal | Redistribute In Competing Product? |
|---|---|---|---|---:|
| [ByteRover](./byterover/byterover-content.md) | Local-first Context Tree, coding-agent connectors, strong coding-knowledge ontology, positive/optimistic sentiment | License posture is not clean for our likely product shape; optional cloud features need boundary review | Elastic License 2.0 | Conditional: ELv2 allows use/modification/redistribution, but not offering it as a hosted/managed service exposing substantial functionality |
| [memd](./memd/memd-content.md) | Explicitly models coding memory categories: decisions, patterns, errors, schemas, constraints, solutions, checkpoints, progress, tasks | Canonical source repo and self-hosted backend source were not verified; quickstart/hosted API ambiguity; heavier Postgres/Qdrant architecture | Site says MIT/open-source/self-hosted; canonical source repo not verified | Unknown / do not rely yet |
| [Codebase-Memory MCP](./codebase-memory-mcp/codebase-memory-mcp-content.md) | Public repo, codebase-memory focus, potentially exactly on-topic | Too little public sentiment; license/storage/schema unclear without direct code audit | Needs audit | Unknown |
| [MemoryGraph](./memorygraph/memorygraph-content.md) | Public graph memory positioned for coding agents | Coding ontology and sentiment evidence are thin | Needs audit | Unknown |
| [MCP Memory Service](./mcp-memory-service/mcp-memory-service-content.md) | Open-source family, local SQLite semantic memory, Claude Code hooks/triggers | More generic semantic memory; canonical repo/license and content model need verification | Needs audit | Unknown |

## Useful Adjacent Patterns, Not Core Coding-Knowledge Memory

| Solution | Why Keep It Nearby | Why It Is Not Core |
|---|---|---|
| [Beads](./beads/beads-content.md) | Best work-management memory pattern: tasks, blockers, dependencies, ready work, discovered follow-ups | It stores work state more than coding knowledge; pair with a knowledge memory layer |
| [Basic Memory](./basic-memory/basic-memory-content.md) | Strong local markdown semantic graph; positive sentiment; excellent observations/relations pattern | Generic knowledge system, not coding-focused by default |
| [Dory](./dory/dory-content.md) | Local markdown corpus plus rebuildable index; good design alignment | Generic/project memory with sparse independent sentiment |
| [SuperLocalMemory](./superlocalmemory/superlocalmemory-content.md) | Local-first, open-source positioning, provenance/trust/poisoning-defense ideas | Generic memory/security architecture more than coding-knowledge ontology |
| [Hindsight](./hindsight/hindsight-content.md) | Strong correction/feedback memory pattern for “do not repeat mistakes” | Behavioral learning layer, not project/codebase memory by itself |

## Excluded By This Filter

| Solution | Main Reason |
|---|---|
| [Mem0](./mem0/mem0-content.md) | Open and positive, but generic personal/agent memory rather than coding-knowledge focused |
| [OpenMemory](./openmemory/openmemory-content.md) | Coding-agent packaging, but storage/local/open-source boundaries are less clear |
| [Letta / MemGPT](./letta-memgpt/letta-memgpt-content.md) | Strong memory architecture, but generic framework memory rather than local coding-knowledge tool |
| [Zep](./zep/zep-content.md) | Strong production memory, but generic app/user graph memory |
| [Graphiti](./graphiti/graphiti-content.md) | Open temporal graph framework, but generic and infrastructure-oriented |
| [Cognee](./cognee/cognee-content.md) | Open knowledge graph memory, but generic document/data memory |
| [LangMem / LangGraph](./langmem-langgraph/langmem-langgraph-content.md) | Useful taxonomy, but framework-native generic memory |
| [LlamaIndex Memory](./llamaindex-memory/llamaindex-memory-content.md) | Generic app/chat memory blocks |
| [Official MCP Memory Server](./official-mcp-memory/official-mcp-memory-content.md) | Open/local, but generic and primitive entity graph |
| [Kage](./kage/kage-content.md) | Open/local graph memory, but generic ontology and sparse sentiment |
| [Engram MCP](./engram-mcp/engram-mcp-content.md) | Too little public detail and sentiment |
| [Supermemory MCP](./supermemory-mcp/supermemory-mcp-content.md) | MCP UX is useful, but backend/product memory is generic and not local-first in the same sense |

## Recommended Working Set For Design

Primary architecture references:

- Cline / Roo Memory Bank
- AgentMemory
- Serena

Conditional architecture references, pending license/source audit:

- ByteRover
- memd

Companion layers to study alongside them:

- Beads for task/work graph continuity.
- Basic Memory for markdown semantic observations and relations.
- SuperLocalMemory for provenance, trust scoring, decay, and memory-poisoning defenses.
- Hindsight for correction/feedback memory.

Likely design direction: combine Memory Bank-style human-readable project files, ByteRover-style structured coding facts and curation operations, AgentMemory-style capture/recall/session traces, memd-style typed coding categories and checkpoints, Serena-style code-intelligence retrieval, and Beads-style work graph as a separate companion layer.
