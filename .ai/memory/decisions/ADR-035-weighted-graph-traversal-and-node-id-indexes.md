# ADR-035: Weighted graph traversal and node id indexes

**Status:** Accepted | **Date:** 2026-09-23 | **Tags:** graph, retrieval, performance, self-host

Amends [ADR-010](ADR-010-opencypher-graph-db-falkordb-default.md) (the graph
layer now manages indexes per provider). Builds on
[ADR-033](ADR-033-graph-ontology-v2.md).

## Context

- `graphTraversal` returned the first 20 paths the engine produced. FalkorDB
  expands the newest edges first, so the result depended on write order. Real
  hubs are lopsided: the largest production Service had 6,309 edges, 6,196 of
  them `HAS_INSTRUCTION`, next to 31 `CONSUMES_API`, 18 `DEPENDS_ON`, 16
  `USES_LIBRARY` and 6 `RUNS_ON`. Dependencies, APIs and owners were crowded out.
- The `validAt` filter had no caller and could not run: FalkorDB has no
  `datetime()`, and projection stores open-ended validity as `""`, not null.
- The advisor hydrated claim evidence only for traversal nodes that ranked in
  the top 20 mixed candidates. Code-search hits usually fill those slots, so
  the model often saw no claim provenance at all.
- No graph indexes existed. Every projection `MERGE` scanned all nodes of its
  kind: 200 `MERGE`s of existing `File` nodes took 5.1 s among 300k `File`
  nodes, and 0.65 ms with an `id` index.

## Decision

1. **Traversal is a best-first walk with a total edge budget** (`limit`, max
   100). Per hop: find the frontier nodes in one lookup pass, fetch their
   edges, keep the top `remaining` per relation type by path trust (product of
   `aggregate_confidence` along the path; 0.5 when missing), then take relation
   types in turns (`pickRoundRobin`). Hops before the last take at most half
   of what is left; budget left at the end goes to the best edges passed over.
   Ties break by claim id, so the result does not depend on write order.
2. **Only edges valid on the query day are walked** (default today). Days are
   compared as `YYYY-MM-DD` strings; `""` and null mean open-ended.
3. **The advisor hydrates every claim the traversal kept** (`state.claimIds`),
   whatever the candidate rank, as one compact row per claim: the fact,
   confidence, validity, evidence count, `sourceType/extractionMethod` of its
   evidence, and a path or URL to cite. Raw evidence ids (about 200
   characters each) and a second, flat evidence list are not sent.
4. **Projection ensures an `id` index per node kind** before `MERGE`, once per
   org and kind per process (`platform/graph/indexes.ts`):
   FalkorDB `CREATE INDEX FOR (n:K) ON (n.id)`; Neo4j
   `CREATE INDEX IF NOT EXISTS FOR (n:K) ON (n.id)`; Memgraph
   `CREATE INDEX ON :K(id)`; Neptune nothing (it indexes on its own).
   "Already indexed" counts as success; any other failure is logged and
   projection continues without the index.
5. Traversal node lookups stay label-less and therefore unindexed; the
   per-kind indexes serve writes.
6. **Label-less matches over many ids scan once per batch**
   (`WHERE x IN $ids`), never once per id (`UNWIND $ids … MATCH`). This
   applies to traversal hops, claim retraction and node deletion. Per 100-id
   batch, retraction went from 658 ms to 11 ms at the current largest org and
   from 10.4 s to 129 ms at 20×; node deletion from 99 ms to 6 ms and from
   1.8 s to 97 ms.

## Rationale

- Relation types take turns instead of pure confidence ordering: containment
  and instruction edges carry confidence equal to or above decisions (0.95 for
  `File PART_OF`, 0.9 for `Decision INFLUENCES`). Confidence says a fact is
  true, not that it answers the question.
- A per-hop walk instead of ordering all paths: a depth-3 enumeration from a
  real hub reaches hundreds of thousands of paths; capping the scan first
  brings write-order dependence back.
- Per-kind indexes instead of a shared `:Node` label: no backfill, no duplicate
  nodes from `MERGE` on a label existing nodes lack, and the projection query
  is unchanged.

## Consequences

- **No reindex or reprojection on deploy.** Traversal reads edge properties
  projection already writes; indexes are created at an org's next projection,
  and FalkorDB indexes existing nodes when the index is created. Orgs that do
  not ingest again never get indexes, and reads do not need them.
- **Latency:** traversal takes ~10 ms median at the current largest org (18k
  nodes, 6.2k-edge hub), was 1–2 ms; ~80 ms at 20× (350k nodes, 50k-edge hub),
  was 12–35 ms. The budget bounds it. The old query was fast because it looked
  at 20 edges picked by write order.
- **Prompt size:** at most `limit` claims per traversal step (default 20; the
  planner runs up to two traversal steps). Per walk of 18 claims, the claims
  section shrank from ~7,500 to ~1,070 tokens, and walked-node candidates from
  ~2,150 to ~850 (ADR-036 readable nodes). A walk now costs ~1,900 tokens
  against ~2,150 before when evidence was crowded out and ~9,650 when not.
- **Engines verified:** `graphTraversal.integration.test.ts`,
  `graphProjection.integration.test.ts` and `indexes.integration.test.ts` pass
  on FalkorDB and Neo4j 5; the first two pass on Memgraph over a
  single-database connection, and its index statement was checked directly
  (Memgraph database per org needs Enterprise; not tested). **Neptune is not verified locally**; check
  through `examples/aws-cdk-self-host` before relying on a change to these
  queries. CI runs no graph database, so these tests run locally only.
- Confidence is mostly a fixed number per extractor today, so ordering within
  a relation type matters little until corroboration and sign-off feed it.
- **Unchanged:** candidate rerank (channel scores stay on incompatible
  scales); the knowledge-graph snapshot still loads every node and edge.

## Alternatives considered

- **Order all paths by confidence, then limit** — rejected: high-confidence
  containment crowds out decisions, and enumeration is unbounded.
- **Shared `:Node` label with one index** — rejected for now: every graph needs
  a backfill before `MERGE` can use it, and adding a label to 350k nodes in one
  query stalled FalkorDB for over nine minutes.
- **Global importance scores (PageRank-style)** — rejected: they reward
  popularity, which amplifies unreviewed copies of a pattern.
