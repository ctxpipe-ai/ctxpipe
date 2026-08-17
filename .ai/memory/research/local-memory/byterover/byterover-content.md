# ByteRover Content Model

Sources: https://docs.byterover.dev/context-tree/curation-engine, https://docs.byterover.dev/context-tree/session-learning, https://docs.byterover.dev/context-tree/query-engine, https://docs.byterover.dev/common-workflows/bootstrap, https://github.com/campfirein/byterover-cli, https://arxiv.org/abs/2604.01599

## What It Stores

ByteRover stores knowledge in a file-based Context Tree:

- domains;
- topics;
- subtopics;
- entries;
- directory `_index.md` summaries;
- `.abstract.md` and `.overview.md` compressed derived files;
- facts inside knowledge files;
- relations/provenance/lifecycle metadata according to the paper abstract;
- optional external-provider memories through Memory Swarm.

Knowledge files include sections such as raw concept, narrative, and facts. The tree lives in `.brv/context-tree/`.

## Semantics / Types It Looks For

ByteRover extracts structured facts with categories:

- personal;
- project;
- preference;
- convention;
- team;
- environment;
- other.

Session Learning extracts up to a small number of durable memories per category. Public docs name:

- patterns;
- preferences;
- entities;
- decisions;
- skills.

The curation engine also detects domains, searches for duplicates, and organizes content hierarchically.

## Extraction Prompt

I did not find a full public extraction prompt body, but the docs expose the curation/extraction contract.

Links:

- curation engine: https://docs.byterover.dev/context-tree/curation-engine
- session learning: https://docs.byterover.dev/context-tree/session-learning
- bootstrap/codebase extraction: https://docs.byterover.dev/common-workflows/bootstrap

Prompt analysis:

- The curation agent chooses among five operations: ADD, UPDATE, UPSERT, MERGE, DELETE.
- It extracts verifiable structured facts into a `## Facts` section.
- It limits session-learned memories by category and length.
- It regenerates summaries after curation.

## How It Manages Memory Soup

ByteRover has strong explicit soup controls:

- hierarchical Context Tree prevents flat memory accumulation;
- ADD/UPDATE/UPSERT/MERGE/DELETE operations let the curator modify structure intentionally;
- duplicate/overlap detection routes to UPDATE or MERGE instead of ADD;
- facts are deduplicated by statement text during merge;
- summaries are regenerated up the tree after curation;
- stale empty indexes are removed;
- adaptive abstract/overview files provide compressed context;
- query uses caches, BM25, LLM prefetch, and relevance thresholds;
- importance increases on updates/search hits;
- recency is reset on updates;
- stale/low-importance entries can become stubs/archives;
- `brv dream` cleans up memory by merging related notes, summarizing links, and archiving stale entries with review for uncertain changes.

## Notes For ctxpipe

ByteRover is one of the strongest content-model references: hierarchical files, small typed facts, operations for merge/update/delete, generated summaries, and lifecycle metadata.

