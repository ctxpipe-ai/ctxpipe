# SuperLocalMemory Content Model

Sources: https://www.superlocalmemory.com/, https://superlocalmemory.com/, https://arxiv.org/abs/2603.02240, https://arxiv.org/abs/2604.04514

## What It Stores

SuperLocalMemory stores local agent memories with emphasis on:

- facts;
- entities;
- relationships;
- concepts;
- patterns;
- agent provenance;
- trust scores;
- learned user/workflow preferences;
- graph clusters;
- retrieval/ranking statistics;
- compressed memories at different fidelity levels.

The V2 paper abstract describes SQLite-backed storage, FTS5 full-text search, graph clustering, event-driven coordination, per-agent provenance, and adaptive reranking.

## Semantics / Types It Looks For

Public materials mention:

- automatic entity extraction;
- relationship mapping;
- concept linking;
- cross-project technology preferences;
- project context detection;
- workflow pattern mining;
- knowledge graph clustering;
- memory-poisoning defense;
- trust scoring by agent.

The site also describes pattern learning and soft prompts injected into agent context.

## Extraction Prompt

No public LLM extraction prompt was found. SuperLocalMemory emphasizes "zero-LLM" memory operations in V3 materials, so core storage/retrieval appears designed to avoid LLM calls for memory management.

Relevant links:

- V2 paper: https://arxiv.org/abs/2603.02240
- V3.3 paper: https://arxiv.org/abs/2604.04514
- site: https://www.superlocalmemory.com/

## How It Manages Memory Soup

SuperLocalMemory's anti-soup strategy is lifecycle/math/security-heavy:

- memories strengthen when used and fade when neglected;
- adaptive lifecycle handles salience;
- smart compression reduces fidelity for cold memories while preserving critical ones;
- cognitive consolidation extracts higher-level patterns from related memories;
- multi-channel retrieval avoids single-vector failure;
- trust scoring and per-agent provenance defend against poisoning;
- graph clustering groups related knowledge;
- learning-to-rank personalizes retrieval;
- process health handles orphan cleanup and inconsistencies.

The main open question is practical inspectability of these mechanisms in the source/runtime.

## Notes For ctxpipe

SuperLocalMemory's strongest contribution is memory governance: provenance, trust, decay, compression, and poisoning defense. These matter for any auto-capture design.

