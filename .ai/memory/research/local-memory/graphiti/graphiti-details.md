# Graphiti Details

Sources: https://github.com/getzep/graphiti, https://help.getzep.com/graphiti/graphiti/overview, https://help.getzep.com/graphiti/graphiti/quick-start, https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/

## Snapshot

Graphiti is an open-source framework for building temporal knowledge graphs for AI agents. It is maintained by Zep and focuses on continuously updated knowledge graphs that preserve history and time.

Status: open-source public repo. Used both as a standalone framework and as part of the Zep ecosystem.

## How It Works

Graphiti ingests "episodes" - text, messages, or structured JSON - then extracts entities and facts into a temporal knowledge graph. It updates existing graph state incrementally rather than rebuilding from scratch. Retrieval uses hybrid search over graph and semantic features.

The key differentiator is time:

- facts have temporal validity;
- contradictions can coexist with time metadata;
- queries can use recency and historical context;
- the graph evolves as new information arrives.

## Storage And Data Model

Graphiti stores:

- episodes;
- entities;
- edges/facts;
- temporal metadata;
- embeddings/search metadata.

Backends include graph databases. Public docs and Neo4j content highlight Neo4j integration, but Graphiti also has local/dev paths depending on version. Verify exact supported stores for target deployment.

## Integrations

Graphiti is a Python framework. It can be integrated into custom agents, LangGraph apps, Zep workflows, and MCP wrappers.

## Selling Points

- Temporal memory is valuable for codebases where "what is true" changes over time.
- Graph plus semantic search is richer than vector-only memory.
- Good fit for continuously changing user/project facts.
- Open-source and documented.

## Open/Closed Source And Target Users

Open-source: yes.

Target users: teams building agent memory infrastructure and knowledge-graph-backed products. Less direct for individual coding-agent users unless wrapped by a local service.

## Risks And Unknowns

- Graph database dependency may be heavy.
- Entity/fact extraction quality determines usefulness.
- Coding-specific schemas would need to be designed.
- A temporal graph can become opaque without good inspection tools.

