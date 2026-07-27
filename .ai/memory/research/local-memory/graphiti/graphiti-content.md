# Graphiti Content Model

Sources: https://github.com/getzep/graphiti, https://help.getzep.com/graphiti/graphiti/overview, https://help.getzep.com/graphiti/graphiti/crud-operations, https://help.getzep.com/graphiti/graphiti/custom-entity-and-edge-types

## What It Stores

Graphiti stores temporal knowledge graphs with these core classes:

- episodic nodes;
- entity nodes;
- community nodes;
- episodic edges;
- entity edges;
- community edges.

Data is ingested as episodes. From those episodes, Graphiti extracts entities and facts/relationships, then stores them with temporal metadata, summaries, embeddings, and links back to source episodes.

## Semantics / Types It Looks For

Default semantics:

- entities;
- relationships;
- facts;
- episodes;
- temporal validity;
- entity summaries;
- communities/clusters.

Custom entity and edge types let developers define domain-specific semantics with Pydantic-style models. Graphiti then extracts entities, classifies them, populates attributes, detects relationships, classifies edge types through `edge_type_map`, extracts edge attributes, validates, and stores.

## Extraction Prompt

I found docs describing the extraction process but not the exact internal prompt text.

Relevant docs:

- custom extraction flow: https://help.getzep.com/graphiti/graphiti/custom-entity-and-edge-types
- CRUD classes: https://help.getzep.com/graphiti/graphiti/crud-operations
- repo: https://github.com/getzep/graphiti

Prompt inference:

- Graphiti's extractor is schema-guided by custom entity/edge types.
- The schema and `edge_type_map` effectively become part of the extraction prompt.
- It must identify entities, classify them into allowed types, extract attributes, identify relationships, classify allowed edge types, and validate against models.

## How It Manages Memory Soup

Graphiti's soup controls:

- raw episodes stay as evidence nodes;
- extracted facts/entities are separate from raw episodes;
- temporal metadata supports changing truth;
- invalidation/expiration can mark facts as no longer valid;
- custom types constrain extraction;
- entity resolution/merge behavior avoids duplicate nodes when working correctly;
- hybrid graph/search retrieval limits context assembly;
- communities summarize clusters.

The main risk is graph sprawl: without good schemas and governance, automatic entity/edge extraction can produce noisy graphs. Public issues around custom edges show schema extraction is powerful but can be brittle.

## Notes For ctxpipe

Graphiti is a strong model for source-backed temporal facts. For ctxpipe, a lightweight temporal graph could complement markdown/task memory, but only if extraction is schema-constrained and reviewable.

