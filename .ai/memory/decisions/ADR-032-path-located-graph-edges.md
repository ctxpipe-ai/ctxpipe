# ADR-032: Path-located graph edges

**Status:** Accepted | **Date:** 2026-09-16 | **Tags:** graph, ingestion, connectors

## Context

Customer graphs sit at roughly one claim per object. The largest orgs are
almost entirely `InstructionUnit` nodes with a single `HAS_INSTRUCTION` edge
onto a Service (or a stub `./` Service on a context repository). Identify
extractors add more 1:1 pairs (`Operation`–`HAS_OPERATION`). Connector dumps
under `linear/`, `notion/`, `slack/`, `confluence/`, and `github/` were fed
through the instruction LLM and became more of those stars.

Pull-request change edges ([ADR-031](ADR-031-github-pr-scoped-mirror.md)) are
one instance of locating an extracted object on a path. They are not the
locating rule.

## Decision

`File` is a **location**, not a document kind. Identity is
`fil:${repositoryId}:${normalizedPath}` (repo-relative; strip `./`; reject
`..`, absolute/HTTP paths, and connector prefixes).

1. **Containment.** `File` `ABOUT` the `Repository` and, when a package root
   matches, `ABOUT` that `Service` / `App` / `Library`. Package roots are
   extractKind keys (`svc|app|lib:${repositoryId}:${root}`), not
   `USES_LIBRARY` keys.
2. **Stated-in.** `InstructionUnit` `ABOUT` `File`. Other code kinds keep
   their existing edges (`EXPOSES_API`, `HAS_OPERATION`, …) and join a path
   through `File ABOUT Service`. Do not add `DEFINED_IN`, `CONTAINS`, or
   `API ABOUT File` until a consumer needs them. `ABOUT` is the extension
   locating/concerns predicate already used by `PullRequest ABOUT Repository`.
3. **Change.** `ADDED` / `MODIFIED` / `REMOVED` / `RENAMED` hang off
   `PullRequest` onto those same `File` keys so source-repo extract and PR
   extract join.
4. **Warehouse.** Instruction extraction skips all connector prefixes.
   Connector Markdown is not an instruction source. Typed connector nodes
   (issue, page, thread) are a later extract, not more `InstructionUnit`s.

## Consequences

- Re-ingest is required before existing customer graphs gain locating edges.
- Connector dumps already promoted to `InstructionUnit` stay until retraction
  or a later cleanup; new ingest will not add more.
- A PR-touched path that identify never mentioned still gets `File ABOUT`
  Service when the source repo is already classified (package roots loaded
  at PR extract).

## Alternatives considered

- **PR-only File edges:** Rejected; leaves the 1:1 instruction star intact.
- **A File node per blob in the repo:** Rejected; unbounded and unused.
- **Every path-bearing kind `ABOUT File`:** Rejected for now. The 1:1 problem
  is `InstructionUnit`. APIs already have `EXPOSES_API`.
- **New `LOCATED_IN` / `DEFINED_IN` predicates:** Rejected; vocabulary growth
  without a consumer. Revisit if `ABOUT` becomes ambiguous in retrieval.
