# First-project migration and idempotent cutover

Type: grilling
Status: open
Blocked by: 01, 02, 03, 09, 10, 11, 18

## Question

At the start of the new version we **queue an OpenWorkflow migration job** (same idea as the SCIP migration in `apps/backend/migrations/20260728140749_t08_enqueue_scip_migration_workflows`) so tenants need **no manual migration**.

**Locked assignment ([Project identity and invariants](18-project-identity-and-invariants.md)) — do not re-grill:**

- Each **connector target** becomes the backing repo of a Project (display name defaults to that repo name).
- Ingested repos that are **not** a connector target **attach** to the Project of the **first connector target**.
- If the org has **no** connector target, those repos stay **unlinked**. When an existing user opens the UI with no Project, **prompt to create a project**; finishing create **automatically attaches** unlinked repositories.
- If linked/attached repos are git-canonical, that auto-attach (and the migration attach-to-first-connector-target) must **commit** `repositories/*.md` into the backing tree (and ops-update `AGENTS.md` if `repositories/` is new), not only write Postgres. Locked by [Git-canonical knowledge and deterministic hydrate](02-hydration-contract.md).

Objects/claims/evidence today are org-scoped; repo identity lives in evidence keys, not a `project_id`.

Settle (assignment itself is locked):

- Sort key for **first** connector target (created-at? name? connection id?).
- How existing objects/claims are assigned **without** an LLM re-extract (which Project’s backing tree they land in).
- What git commit(s) the job creates (export to the layout from [Knowledge Markdown and front-matter layout](03-knowledge-file-layout.md), via [Ingest-to-git write and concurrency protocol](10-ingest-to-git-write-protocol.md)).
- Import conflicts if the target repo already has knowledge files ([Project repository create, select, relink, and import](09-project-repository-lifecycle.md)).
- Idempotency: re-run mid-index, or when knowledge files already exist.
- Failure isolation: one tenant failing must not block others.
- Cutover visibility: tenants stay on old org-wide chat/graph until hydrate of the migration SHA succeeds?
- Prompt copy and when it fires (every session until a Project exists? dismissible?).

Recommend the dumbest remaining rules that do not drop data and do not invent a second source of truth.

## Comments

### From [Project repository create, select, relink, and import](09-project-repository-lifecycle.md)

Create/relink is any **member**. Auto-attach of unlinked repos is a `repositories/*.md` commit in the **backing** tree — paused if that backing is read-only. Connector-target → backing still holds; if the App cannot write that target, the new Project is read-only until access is fixed (installation admin adds the repo, etc.).
