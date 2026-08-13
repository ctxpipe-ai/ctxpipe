# First-project migration and idempotent cutover

Type: grilling
Status: open
Blocked by: 01, 02, 03, 09, 10, 11

## Question

At the start of the new version we **queue an OpenWorkflow migration job** (same idea as the SCIP migration in `apps/backend/migrations/20260728140749_t08_enqueue_scip_migration_workflows`) so tenants need **no manual migration**.

The brief's grouping rules can conflict:

- Integrations group by the repository they already bind to; that repository becomes a Project named after the repo.
- **All** content already in the databases becomes part of the **first** Project.

Objects/claims/evidence today are org-scoped; repo identity lives in evidence keys, not a `project_id`.

Settle:

- How "first Project" is chosen when an org has zero, one, or many repositories.
- How existing objects/claims are assigned **without** an LLM re-extract.
- Connector targets on **different** repos: multiple Projects immediately, or one Project plus later splits?
- Ingested GitHub repos with **no** connectors: one Project per repo, or one Project containing them?
- What git commit(s) the job creates (export to the layout from [Knowledge Markdown and front-matter layout](03-knowledge-file-layout.md), via [Ingest-to-git write and concurrency protocol](10-ingest-to-git-write-protocol.md)).
- Import conflicts if the target repo already has knowledge files ([Project repository create, select, relink, and import](09-project-repository-lifecycle.md)).
- Idempotency: re-run mid-index, or when knowledge files already exist.
- Failure isolation: one tenant failing must not block others.
- Cutover visibility: tenants stay on old org-wide chat/graph until hydrate of the migration SHA succeeds?

Recommend the dumbest rule that does not drop data and does not invent a second source of truth.
