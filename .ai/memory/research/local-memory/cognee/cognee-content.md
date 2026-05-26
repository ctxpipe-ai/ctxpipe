# Cognee Content Model

Sources: https://github.com/topoteretes/cognee, https://github.com/topoteretes/cognee/blob/main/CLAUDE.md, https://docs.cognee.ai/, https://github.com/topoteretes/cognee/issues/1350

## What It Stores

Cognee stores knowledge extracted from ingested data into graph, vector, and relational stores. Its documented workflow is:

- `add`: ingest data;
- `cognify`: classify/chunk/extract/build graph;
- `search` / `recall`: retrieve;
- `memify` / `improve`: enrich memory.

Stored content includes:

- source documents/data;
- chunks;
- graph nodes/entities;
- graph relationships;
- node descriptions;
- summaries;
- vector embeddings;
- session memory;
- permanent knowledge graph entries;
- workflow patterns and outcomes in agent integrations.

## Semantics / Types It Looks For

Cognee's generic pipeline looks for:

- entities;
- relationships;
- graph structure;
- summaries;
- document topics;
- patterns from workflows;
- domain knowledge from company/project data;
- schema structures for database ingestion.

The Claude Code/plugin material describes lifecycle capture: session start initializes memory, tool calls are captured, user prompts receive relevant context, pre-compact preserves memory, and session end bridges session data into the permanent graph.

Issue #1350 is useful because it explicitly calls out memory soup in database ingestion: ingesting entire databases creates excessive graph noise, while schema-only ingestion should store tables, columns, relationships, and limited samples in an isolated `database_schema` nodeset.

## Extraction Prompt

I found pipeline and schema descriptions but not a full public extractor prompt body.

Relevant links:

- architecture/pipeline notes: https://github.com/topoteretes/cognee/blob/main/CLAUDE.md
- repo README: https://github.com/topoteretes/cognee
- database-schema ingestion proposal: https://github.com/topoteretes/cognee/issues/1350

Prompt inference:

- Cognee uses an LLM/instructor-style extraction task to turn chunks into typed graph data.
- The effective extraction schema is the graph model/data-point model used by tasks such as `extract_graph_from_data`.

## How It Manages Memory Soup

Cognee uses several anti-soup mechanisms:

- separates raw ingestion, graph extraction, vector storage, and search;
- pipeline tasks are composable and can be tuned;
- graph and vector stores support different retrieval modes;
- session memory can sync to permanent graph at session end;
- search types include graph completion, graph summary completion, triplet completion, and RAG completion;
- permissions/user isolation are part of the product positioning;
- database ingestion issue shows explicit awareness of over-ingestion and proposes schema-only, sampled, isolated nodesets.

The risk is over-ingestion: Cognee can ingest many formats and sources, so it needs domain-specific pipelines to avoid turning everything into noisy graph nodes.

## Notes For ctxpipe

Cognee's lesson is to avoid ingesting whole systems blindly. For codebases, schema/code extraction should be selective, scoped, and purpose-built.

