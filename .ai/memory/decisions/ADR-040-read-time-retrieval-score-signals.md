# ADR-040: Read-time retrieval score signals

**Status:** Accepted | **Date:** 2026-10-05 | **Tags:** graph, retrieval, connectors

Amends [ADR-035](ADR-035-weighted-graph-traversal-and-node-id-indexes.md) §1
(how the walk orders edges), [ADR-036](ADR-036-decision-scope-and-status.md)
§3 (where decision status applies) and
[ADR-033](ADR-033-graph-ontology-v2.md) §2 (the change family gets
`CHANGED`).

## Context

- The walk of ADR-035 ordered edges by path trust: the product of
  `aggregate_confidence` along the path, times the decision status. That
  weight was weaker than it looked. `aggregateConfidence` is a weighted
  average: with one evidence row, the source weight, the method weight and
  the decay cancel. Agreement did not raise it. `source_count` was on every
  edge, but the walk did not read it.
- The search hits only broke ties. All relation families took equal turns,
  whatever the question asked.
- A retrieval evaluation on a synthetic graph with real hub shapes (a
  service with 900 files and 3,000 instructions, 30 ADRs, 400 pull
  requests over two years) gave recall of 0.70 for "why" questions and
  about 0 for "what changed recently". The "why" walk lost recall when
  `DECLARED_IN` and the change family joined it: they took turns from
  `INFLUENCES`. A walk from a service reached its pull requests only through
  its files.
- `source_count` is the number of `claim_evidence` rows. A row is one
  logical source: an extractor and its target, without the commit hash. A
  repeat observation of the same source updates its row. But two
  extractors can read one file, one extractor can see a fact in two
  packages, and a mirror copies a source, so the rows are not fully
  independent.

## Decision

1. **Each candidate edge gets a score at read time** from five signals
   (`retrieval/services/retrievalScore.ts`, a module with no imports):
   - **Truth**: noisy-OR, `1 - (1 - c)^min(n, 3)`, at most 0.98. `c` is the
     stored confidence (0.5 when missing). `n` is `source_count` (at least
     1). Path truth is the product along the path, and only truth goes to
     the next hop.
   - **Authority**: the ADR status (accepted 1.0, undeclared 0.9, proposed
     or draft 0.6, deprecated, superseded or rejected 0.3) and the pull
     request review decision (approved 1.0, none 0.8, changes requested
     0.6). For a question about history (`why`, `change`), the status of
     an ADR does not lower it.
   - **Search**: 0.5 for a miss; for a hit, 0.5 to 1 by its hybrid search
     score divided by the top score.
   - **Recency**: `max(0.1, 2^(-age / 90 days))` for events: change edges
     (from `valid_from`), pull requests (`merged_at`) and threads
     (`captured_at`). State facts do not decay. `last_observed_at` is not
     used: after a backfill, every fact has the same ingest time.
   - **Specificity**: `degree^-0.5`. A search hit is exempt, because the
     question names it.
2. **The score is `exp(Σ wᵢ · ln max(sᵢ, 0.05))`**, a weighted product. The
   floor makes sure that one weak signal cannot remove a fact.
3. **A fixed classifier reads the intent of the question** (no model call):
   `why`, `ownership`, `change`, `structure`, else `general`, in that
   order. The intent sets the signal weights and the turns of each relation
   family:

   | Intent | Turns per round | Weights that differ from 1 |
   |---|---|---|
   | general | 1 each | recency 0 |
   | ownership | `OWNS` 3 | recency 0, specificity 0 |
   | why | `INFLUENCES` 3, `SUPERSEDES` 2 | recency 0 |
   | change | change family 3, `TARGETS` 3, `REFERENCES` 2 | specificity 0.5 |
   | structure | structural predicates 3 | recency 0 |

   In `pickRoundRobin`, a family with `k` turns takes up to `k` edges in
   each round. The families with more turns go first in a round, so a small
   hop cap still goes to them. Each other family still gets one turn.
4. **The per-type slice is wider** (4 times what is left, 40 to 200), so the
   score can reorder it. Cypher orders the slice by search hits first (there
   are few), then by the trust of ADR-035 (without the status for a
   question about history), then by more evidence, then by the newest
   `valid_from`.
5. **One more query per hop reads the degree of the candidates.** It has
   one `UNION ALL` part for each kind, so the per-kind `id` index of
   ADR-035 finds the nodes. The kind passes the `SAFE_CYPHER_IDENT` rule
   before it goes into the query text.
6. **`PullRequest CHANGED Service|App|Library`**: the pull request mirror
   writes one deterministic claim (0.95, `valid_from` = merge date) for each
   package that holds a changed path, removed paths too. `CHANGED` is in
   the change family and in the extension walk.
7. **Options for an evaluation**: `query`, `intent` (replaces the
   classified intent), `weights` (replaces single weights; 0 switches a
   signal off) and `searchHits`, which replaces `preferIds`. The result also
   gives the kept edges with their score and signals (`edges`).

## Rationale

- Confidence keeps one meaning, the chance that a fact is true. Authority,
  relevance, recency and specificity answer other questions, so they are
  separate signals. A change of weights needs no reindex, as in ADR-036.
- Noisy-OR assumes independent evidence (NELL), and the rows are only
  partly independent, so `n` is at most 3 and truth is at most 0.98.
- A recency prior helps only questions about time (Li and Croft).
  History questions need superseded and rejected ADRs: they tell what was
  tried and why it changed.
- `degree^-0.5` follows HippoRAG and RP3β. The opposite (prominence, as in
  GraphRAG) amplifies `package.json` and repository-wide ADRs.
- Every weight starts at 1, as in a log-linear model (Metzler and Croft),
  until an evaluation fits them.
- Turns, not only scores, carry the intent: scores order edges within a
  family, and the turns decide how much of the budget each family gets.
- A label-less degree query scanned the whole graph three times per walk.

## Consequences

- **No reindex for the signals.** They read edge and node properties that
  projection already writes. `CHANGED` edges need the pull request mirror
  extracted again: a deterministic-only re-index of the context repository
  (no LLM extractor).
- **Latency** on FalkorDB, 18.6k nodes with a 6.2k-edge hub, depth 3 and
  20 edges (median): 28.6 ms; 26.1 ms with specificity off; 20.6 ms for the
  walk of ADR-035. The label-less degree query took 40.8 ms. The wider slice
  costs about 5 ms; the degree query about 2.5 ms.
- **Engines verified:** `graphTraversal.integration.test.ts` (18 scenarios)
  and `graphProjection.integration.test.ts` pass on FalkorDB, Neo4j 5 and
  Memgraph; `indexes.integration.test.ts` passes on FalkorDB and Neo4j 5.
  The walk adds no function to the Cypher; the degree query adds
  `UNION ALL`. **Neptune is not verified.**
- Six of the seven new scenarios fail on the walk of ADR-035. With the
  general intent, the "why" and "who owns" scenarios fail, so the intent
  makes them pass.
- The classifier is a set of patterns. It can be wrong ("help me decide"
  reads as `why`); then the walk uses the turns of that intent.
- The degree counts every edge of a node. A team that owns many issues has
  a high degree, so the ownership intent switches specificity off.
- **Follow-ups:** group evidence by an independence key (producer and
  upstream artifact) when a claim is written, and combine one value per
  group (Knowledge Vault counts each domain once). Fit the weights on an
  evaluation. A query-seeded personalized PageRank over the collected
  candidates can replace the per-hop order later; the scoring module and
  the per-hop candidate sets keep that change local. Outcome (cited facts,
  corrections) is not a signal yet.

## Alternatives considered

- **Noisy-OR in Cypher**: rejected. It needs `^` or a `CASE` chain in each
  query, and an evaluation cannot switch it off. The slice uses more
  evidence as a tie-break.
- **Degree written at projection**: not needed. The label-scoped degree
  query costs about 2.5 ms per walk, and a stored degree goes stale between
  projections.
- **`last_observed_at` for recency**: rejected. It is the ingest time, the
  same for every fact after a backfill.
- **Recency for every intent**: rejected. The pull request that added an
  old ADR is still the answer to "why".
- **Families in score order within a round**: rejected. A small hop cap cut
  the family that the question asks about.
