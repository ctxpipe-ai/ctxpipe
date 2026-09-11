# ADR-008: Codesearch Zoekt, SCIP, and ast-grep

**Status:** Accepted | **Date:** 2026-02-15 (amended 2026-09-11) | **Tags:** codesearch, zoekt, scip, ast-grep, indexing

## Context

We need lexical search, symbol navigation, and structural matching across large
customer repositories. The service stays in the monorepo, uses the same Postgres
as the backend, and indexes on demand (no discovery). Splitting SCIP or
structural search into another service was rejected.

## Decision

1. **One app, one checkout.** [`apps/codesearch`](../../../apps/codesearch) (Bun,
   Hono, OpenAPI + Zod) clones or checks out a repository once. Zoekt indexing
   and language-specific SCIP indexers run in parallel. The checkout is marked
   indexed only after both required phases succeed. Indexing fails closed if
   either phase fails. An empty SCIP index is published when no supported
   language is present. Partial ingests reuse untouched language shards.

2. **Query split.** Zoekt owns text, regex, and rough symbol discovery. SCIP owns
   definitions, references, implementations, callers, and callees (caller/callee
   results are reference-based). ast-grep owns syntax-aware structural patterns.
   Checkout plus Zoekt backs file reads and listings.

3. **Stable agent tools.**

   | Tool | Implementation |
   |------|----------------|
   | `search` / `find_symbol_definitions` | Zoekt lexical and symbol discovery |
   | `find_symbol_references` | Heuristic Zoekt reference search |
   | `graph_find_symbol` | SCIP definitions and implementations |
   | `graph_get_callers` | SCIP references into callable definitions |
   | `graph_get_callees` | SCIP references originating in a callable definition |
   | `structural_search` | ast-grep patterns scoped to a repository checkout |
   | `list_files` / `get_file` | Checkout and Zoekt-backed file access |

4. **Repositories in backend.** The `repositories` table and Drizzle migrations
   live in backend. Codesearch mirrors the schema and may write only the
   indexing lifecycle field after a successful index. IDs are
   `<prefix>_<base32 uuid>`; repositories use `repo_`.

5. **Clone and cache paths.** No `clone_path` column. Checkout is
   `<org_id>/<repo_id>` under `REPO_CACHE_DIR` (default `/data/repo-cache`).
   Zoekt index default is `/data/zoekt-index`. Host dev bind-mounts
   `apps/codesearch/.data/` via [`scripts/codesearch-docker-dev.sh`](../../../scripts/codesearch-docker-dev.sh).
   GitHub tokens are per-request from the backend.

6. **No discovery.** Index only repositories explicitly requested. Fresh and
   updated repositories use the normal indexing path; existing repositories
   migrate through the ingestion workflow.

Implementation: [`apps/codesearch/src/domain/indexing/service.ts`](../../../apps/codesearch/src/domain/indexing/service.ts),
[`scipIndexers.ts`](../../../apps/codesearch/src/domain/indexing/scipIndexers.ts),
[`executeGraphPrimitive.ts`](../../../apps/codesearch/src/domain/graph/executeGraphPrimitive.ts),
[`structuralSearch.ts`](../../../apps/codesearch/src/domain/search/structuralSearch.ts),
[`apps/backend/src/tools/repoExplorerTools.ts`](../../../apps/backend/src/tools/repoExplorerTools.ts),
[`apps/codesearch/Dockerfile`](../../../apps/codesearch/Dockerfile).

## Consequences

- Backend remains the single migration owner; codesearch updates a narrow
  lifecycle field after index success.
- Zoekt and SCIP run in the same codesearch image/process boundary (see
  [ADR-015](ADR-015-docker-compose-profiles-and-small-scale-deploy.md)); there is
  no separate Zoekt-only search service.
- Structural search stays argv-only, streamed, path-contained, and bounded.
- Immutable published checkouts and SHA-bound claims are owned by
  [ADR-032](ADR-032-workspace-revision-projection-identity.md) and
  [ADR-033](ADR-033-native-durable-write-workflows.md).

## Alternatives Considered

- **Repositories table in codesearch:** rejected so all migrations stay in backend.
- **A second indexing service for SCIP or ast-grep:** rejected; one checkout
  keeps lexical, graph, and structural artifacts aligned.
