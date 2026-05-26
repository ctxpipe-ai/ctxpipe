# Zep Content Model

Sources: https://help.getzep.com/concepts, https://help.getzep.com/facts, https://help.getzep.com/v2/understanding-the-graph, https://help.getzep.com/graphiti/graphiti/overview

## What It Stores

Zep stores user and application memory in a temporal knowledge graph. Public docs name these context primitives:

- facts;
- entities;
- episodes;
- thread summaries;
- observations;
- user summary.

Graph data includes:

- entity nodes with summaries;
- entity edges representing relationships and semantic facts;
- episodic nodes representing raw data from chat history or graph ingestion;
- temporal metadata such as valid/invalid timestamps.

## Semantics / Types It Looks For

Zep looks for:

- entities;
- relationships between entities;
- precise time-stamped facts;
- facts that invalidate older facts;
- observations;
- summaries of users or threads;
- business/user data added through JSON, text, or messages.

The docs distinguish user graphs from arbitrary graphs. A user graph stores personalized context about a user; other graphs store up-to-date knowledge about objects/systems.

## Extraction Prompt

I did not find Zep's production extraction prompt. The docs explain the graph update behavior but do not expose prompt bodies.

Relevant docs:

- facts and invalidation: https://help.getzep.com/facts
- graph concepts: https://help.getzep.com/v2/understanding-the-graph
- key concepts: https://help.getzep.com/concepts

## How It Manages Memory Soup

Zep's anti-soup story is temporal graph modeling:

- raw episodes remain distinct from extracted entities/facts;
- facts live on edges with timestamps;
- invalidation marks prior facts as no longer valid instead of overwriting history;
- summaries provide compressed context;
- the context block assembles relevant facts and user summaries for prompt use;
- custom entity/edge types can constrain extraction for a domain;
- graph search retrieves entities/facts instead of dumping all memory.

The risk is opacity: the graph is powerful, but users need visibility into why a fact was extracted, invalidated, or retrieved.

## Notes For ctxpipe

Zep is a strong reference for temporal validity. For codebases, architectural truths change; storing `valid_at` / `invalid_at` style metadata could prevent stale-memory bugs.

