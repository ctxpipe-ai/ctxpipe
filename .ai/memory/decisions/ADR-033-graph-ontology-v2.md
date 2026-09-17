# ADR-033: Graph ontology v2 — relation families, shared identity, deterministic connector extraction

**Status:** Accepted | **Date:** 2026-09-17 | **Tags:** graph, ingestion, connectors, retrieval

Amends [ADR-032](ADR-032-path-located-graph-edges.md) §2 (predicates) and §4
(connector nodes). Builds on [ADR-031](ADR-031-github-pr-scoped-mirror.md).

## Context

Customer graphs sat at roughly one edge per node: `InstructionUnit` stars on a
stub root Service, `Operation` stars on an API. Connector Markdown (Linear,
Notion, Slack, Confluence) reached the graph only by being LLM-read as
"instructions". Five declared kinds (`Concept`, `Capability`, `Topic`,
`Incident`, `Decision`) had no extractor. `ABOUT` carried four meanings. No
edge carried time although claims support validity. Evidence source ids on the
PR-mirror branch embedded the target hash mid-string and omitted repository
ids, which defeated evidence dedup, retraction and purge.

ctxpipe's product promise is an org-scoped graph that compounds with every
commit, decision and agent run. Compounding requires cross-tool edges, and
cross-tool edges require shared identity.

## Decision

1. **Kinds are real provider things.** New extension kinds: `Issue`, `Team`,
   `Thread`; `Decision` gains an extractor. `Concept`, `Capability`, `Topic`
   are removed from the schema and planner until an extractor exists.
   `Incident` stays declared for the future operations connector.
2. **Predicates come in families with fixed semantics** (`allowedConnections.ts`,
   `PREDICATE_DESCRIPTIONS`):
   containment `PART_OF`; provenance `DECLARED_IN`, `MEMBER_OF_PRIMARY`;
   change `TARGETS`, `ADDED`, `MODIFIED`, `REMOVED`, `RENAMED`; reference
   `REFERENCES`, `MENTIONS`, `SUPERSEDES`; ownership `OWNS`; cause
   `INFLUENCES`. `ABOUT`, `RELATES_TO`, `ASSOCIATED_WITH` are retired. The
   extension traversal walks the reference, cause and ownership families.
3. **Identity is shared.** `domain/codeIngestion/referenceResolver.ts` is the
   only place that turns URLs, identifiers and paths into keys:
   `prq:${repoId}:${n}`, `iss:linear:${IDENT}`, `team:linear:${KEY}`,
   `team:github:${org}/${slug}`, `thr:slack:${channel}:${ts}`,
   `dec:${repoId}:${path}`, `fil:${repoId}:${path}`. Bare Linear identifiers
   match only known team keys.
4. **Connector Markdown is parsed, never LLM-read.**
   `nodes/connectorExtractors.ts` is a registry keyed by warehouse prefix; a
   connector ships its frontmatter contract and its extractor together.
   Source-repo extractors add `Decision` (ADR files) and `Team OWNS`
   (CODEOWNERS). Reference-family claims whose ends do not resolve are dropped
   once after all roots concatenate (`finalizeExtractedReferences`), with a
   per-predicate summary log.
5. **Time is first-class.** `ExtractedClaim` carries optional `validFrom` /
   `validTo`; change edges set `validFrom` to the merge date; containment is
   not asserted for a path a pull request removed.
6. **Evidence ids follow `${extractor}:${repositoryId}:…:${targetHash}`**
   (`domain/codeIngestion/evidenceSourceId.ts`). Cross-repository claims carry
   both repository ids and the warehouse path as segments.
7. **Connector-only partial diffs skip the code extractors**
   (`shouldSkipCodeExtractorForPartialDiff`).
8. **Graph health is measured by join density** (`GET /knowledge-graph/quality`):
   share of objects with evidence from two or more extractors, plus orphan
   rate, evidence rows per claim, and the count of legacy connector-derived
   instruction units. A one-off admin action
   (`POST /knowledge-graph/maintenance/retract-connector-instructions`)
   removes those units and the nodes left orphaned.

## Rationale

- Ten extractors that each emit their own stars do not compound; one resolver
  that glues them onto shared `PullRequest`, `File`, `Service`, `Team` nodes does.
- Distinct relation families let the planner and traversal compose paths with
  a stable meaning (`PullRequest MODIFIED File PART_OF Service` reads as "the
  PR touched the service"); one overloaded predicate cannot.
- Renaming predicates before release costs a find-and-replace; afterwards it
  costs a re-projection per customer graph.
- The LLM stays where it adds information that is not already written down:
  package classification, structure identification, and later promotion of
  recurring review comments into norms.

## Consequences

- Full re-ingest of connected repositories is required for `File PART_OF`,
  `Decision`, `Team` and connector nodes to appear; run the maintenance action
  first so legacy units do not survive alongside them.
- The hosted GitHub App must subscribe to review, review-comment and
  issue-comment events and hold Issues: Read (ADR-031).
- `Issue` identity is org-scoped by identifier; two Linear workspaces with
  colliding team keys in one org would merge issues (known limitation).
- Bare-identifier matching in PR text depends on `Team` nodes already existing;
  the first ingest of a context repository links by URL only.
- `Document` (Notion / Confluence), `Incident`, `Person`, and the promotion
  pass are deliberately out of this decision (see the graph overhaul proposal).

## Alternatives considered

- **Keep `ABOUT` for everything structural** — rejected: traversal and planner
  cannot distinguish containment from aboutness.
- **Generic `Document` node for every connector file** — rejected for typed
  provider kinds; retained as the plan for pages without a join key.
- **LLM entity extraction over connector bodies** — rejected as the primary
  path; it recreates the star at higher cost. Kept as a later linking fallback.
- **Stub nodes for unresolved references** — deferred until the measured
  Issue-to-PR link rate shows a need.
