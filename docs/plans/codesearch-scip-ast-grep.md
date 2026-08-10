# Shipped: Reliable codesearch structural intelligence

**Status:** Implemented; the migration draft is superseded by the shipped architecture.
**Goal:** Provide dependable lexical search, symbol navigation, and structural matching across large customer repositories without splitting indexing into another service.

## Shipped architecture

Codesearch remains one service with one checkout:

```text
POST /index
  → clone / checkout
  → Zoekt indexing ───────────────┐
  → language-specific SCIP indexers ─┤ run in parallel
                                    └→ mark checkout indexed after both succeed

Queries
  → Zoekt       text, regex, and rough symbol discovery
  → SCIP        definitions, references, implementations, callers, and callees
  → ast-grep    syntax-aware structural patterns
  → checkout    file reads and listings
```

SCIP indexers are selected from the repository's detected languages. Their shards
are merged into the checkout's published `.scip` index. Partial ingests reuse
untouched language shards and regenerate only affected languages. An empty SCIP
index is published when no supported language is present.

## Agent tool contract

The existing graph tool names remain stable:

| Tool | Implementation |
|------|----------------|
| `search` / `find_symbol_definitions` | Zoekt lexical and symbol discovery |
| `find_symbol_references` | Heuristic Zoekt reference search |
| `graph_find_symbol` | SCIP definitions and implementations |
| `graph_get_callers` | SCIP references into callable definitions |
| `graph_get_callees` | SCIP references originating in a callable definition |
| `structural_search` | ast-grep patterns scoped to a repository checkout |
| `list_files` / `get_file` | Checkout and Zoekt-backed file access |

SCIP caller and callee results are reference-based. The backend tool descriptions
and planner prompts state this explicitly and distinguish SCIP from Zoekt and
ast-grep.

## Reliability behavior

- Zoekt and SCIP indexing run concurrently, but indexing fails closed if either
  required phase fails.
- Subprocess output is tailed with bounded memory rather than retained in full.
- SCIP decoding and graph traversal run in process with bounded, weighted cache
  entries and concurrent-load de-duplication.
- Structural search uses argv-only process spawning, streamed JSON, bounded
  results, and checkout path/symlink containment checks.
- The production image contains the supported SCIP toolchain, ast-grep, language
  runtimes, and build tools, with required and forbidden binary assertions.
- Existing repositories are queued for migration indexing through the workflow
  migration, while fresh and updated repositories use the normal indexing path.

## Verification

Coverage now includes:

- SCIP protobuf decode, merge, definitions, references, callers, callees,
  implementations, type hierarchy, cache bounds, and concurrent loading.
- Language detection, indexer argv generation, partial-ingest shard reuse, merged
  index publication, and fail-closed phase handling.
- Structural-search request validation, safe process arguments, streamed output,
  and path traversal/symlink rejection.
- Backend tool registration, authenticated codesearch requests, and planner/tool
  descriptions for choosing Zoekt, SCIP, or ast-grep.
- Production-image toolchain smoke checks.

## Implementation pointers

- Index orchestration: `apps/codesearch/src/domain/indexing/service.ts`
- SCIP indexers: `apps/codesearch/src/domain/indexing/scipIndexers.ts`
- SCIP query adapter: `apps/codesearch/src/domain/graph/executeGraphPrimitive.ts`
- Structural search: `apps/codesearch/src/domain/search/structuralSearch.ts`
- Backend explorer tools: `apps/backend/src/tools/repoExplorerTools.ts`
- Production toolchain: `apps/codesearch/Dockerfile`
