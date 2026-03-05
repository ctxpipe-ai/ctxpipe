# ADR 0001 - Codesearch service and Zoekt orchestration

- **Status**: Accepted
- **Date**: 2026-02-15

### Context

We need a code search and indexing experience powered by [Zoekt](https://github.com/sourcegraph/zoekt). The solution should live in the monorepo as a separate app, use the same Postgres as the backend, and expose search, indexing, and file-serving APIs. Repository metadata is owned by the backend; indexing is on-demand only (no discovery).

### Decision

1. **New app `apps/codesearch`**: Bun service (Hono, OpenAPI + Zod) that orchestrates Zoekt and serves search/file APIs. Structure mirrors `apps/backend` (server, app, routes, config, db).

2. **Repositories in backend**: The `repositories` table and all Drizzle migrations live in **backend** (`apps/backend/src/db/schema/index.ts`). Codesearch mirrors this table schema and may write only the indexing lifecycle field `index_ready` after successful indexing. All other writes (get-or-create repo, metadata changes, etc.) are done by the backend. IDs use **TEXT** and format **`<prefix>_<base32 encoded uuid>`**; repositories use prefix **`repo_`**. `zoekt_repo_id` is an autoincrement integer.

3. **Clone path convention**: No `clone_path` column. Clone location is **`<org_id>/<repo_id>`** under a fixed repo cache base path (e.g. `/data/repo-cache`), defined in code, not env.

4. **Index and repo cache**: `ZOEKT_INDEX_DIR` and `REPO_CACHE_DIR` are **not** configurable; fixed paths in code (e.g. `/data/zoekt-index`, `/data/repo-cache`). Only `DATABASE_URL` is configurable env. GitHub tokens are passed per-request by the backend (minted from the GitHub App installation).

5. **Indexserver / indexing**: No discovery. Indexing is only for repositories explicitly requested (e.g. POST `/:repoId/index`). Clone and run `zoekt-git-index` (or invoke indexserver for a single repo); no mirror config or org/user sync.

6. **Session/tenant (temporary)**: Mock org is a constant in code (`MOCK_ORG_ID`); no env or headers until auth is integrated.

### Consequences

- Single place for migrations (backend); codesearch keeps a schema mirror in sync and performs a narrow lifecycle update (`index_ready`) after indexing succeeds.
- Consistent ID and path conventions across services.
- On-demand indexing keeps control and avoids unnecessary sync.

### Alternatives Considered

- **Repositories table in codesearch**: Rejected so all migrations stay in backend.
- **Configurable index/cache dirs**: Rejected per product choice; fixed paths in code.

### Notes

- Zoekt webserver runs separately (e.g. same Docker stack, not in the same image as Bun). Bun app proxies POST /search to Zoekt.
- Full clone + zoekt-git-index in POST /:repoId/index can be implemented next; stub returns ok for now.
