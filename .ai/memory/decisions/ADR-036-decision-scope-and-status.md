# ADR-036: Decision scope and status in the graph

**Status:** Accepted | **Date:** 2026-09-23 | **Tags:** graph, ingestion, retrieval, decisions

Amends [ADR-033](ADR-033-graph-ontology-v2.md) (`Decision INFLUENCES Service`
was by location only). Builds on
[ADR-035](ADR-035-weighted-graph-traversal-and-node-id-indexes.md).

## Context

- Two production orgs hold ADRs (ctxpipe 35, TruRec 4). Production had two
  `Decision INFLUENCES Service` edges in total and none in the ctxpipe org:
  its ADRs live in a shared monorepo folder, and the repository root is not
  a service.
- No `SUPERSEDES` edges existed, although three ctxpipe ADRs are superseded.
  The parser read only plain "superseded by ADR-24" in prose, after
  stripping the status header where supersession is declared, usually as a
  link (`Superseded by [ADR-024](...)`, MADR `superseded by [ADR-0005](...)`).
- Walked nodes reached the advisor as opaque object ids (`obj_…`), so a
  superseded ADR looked like any other node.
- Two orgs and 39 ADRs are too few to fit weights to; the ADR lifecycle is
  a published convention.

## Decision

1. **Scope follows the narrowest signal the ADR gives.** Its package
   (confidence 0.9); else the services whose paths it references, from
   backticked repository paths and relative Markdown links resolved from the
   ADR's folder, URLs ignored (0.8); else every service in its repository
   (0.6). Only `Service` targets, per the allowed triples.
2. **Supersession is read from declared metadata** (front-matter status, the
   bold header, `Status:` line or section, and lines starting with
   "Supersedes" / "Superseded by"), including the linked form. Prose counts
   only in plain form, since a linked mention there usually describes
   another ADR.
3. **Status weights decisions at read time**, following the ADR lifecycle
   (Nygard; MADR statuses): accepted 1.0, undeclared 0.9, proposed or draft
   0.6, deprecated, superseded or rejected 0.3. The factor multiplies path
   trust in `graphTraversal`; only the order it produces matters.
4. **Walked nodes are readable:** the traversal returns each reached node's
   kind, name and status, and traversal candidates carry them in place of
   the claim id list.

## Rationale

- ADR tooling scopes decisions by where they live (per-package ADR folders
  in log4brains; the Backstage ADR plugin attaches an ADR folder to the
  owning component), and a repository-level ADR governs the repository.
  Explicit references narrow that.
- Status belongs to the decision, not the link: "this ADR shapes billing"
  stays true when the ADR is superseded; whether it is in force does not.
  Weighting at read time also means no reindex when the weights change.

## Consequences

- Scope and supersession take effect when a repository's ADRs are next
  extracted. Roll out with a deterministic-only run
  (`reindex-repositories --deterministic-only`): it re-reads the repository
  with only the deterministic extractors, makes no LLM calls, and skips the
  unobserved-evidence sweep so LLM-extracted facts are kept. A full reindex
  or the ADR files changing also picks it up. Status weighting and readable
  nodes take effect on deploy.
- ctxpipe's 35 ADRs: 14 scoped by reference, 21 repository-wide. Paths
  written relative to a package (`domain/codeIngestion/…`) are not
  resolved, so those ADRs fall back to repository-wide; resolving them
  needs a file listing.
- Repository-wide fan-out adds one edge per service at 0.6; relation types
  taking turns and trust ordering keep them behind specific links.

## Alternatives considered

- **`Decision INFLUENCES Repository` for repository-wide ADRs** — rejected
  for now: the extension walk used for "why" questions does not cross
  `IMPLEMENTED_IN`, so a service could not reach the decision.
- **Status in the claim's confidence at extraction** — rejected: it mixes
  whether the link is true with whether the decision is in force, and a
  change would need a reindex.
- **Scope through `Decision MENTIONS File` edges** — rejected: `File` nodes
  exist only for path-bearing objects; production held one such edge.
- **Matching service names in prose** — rejected: false positives.
