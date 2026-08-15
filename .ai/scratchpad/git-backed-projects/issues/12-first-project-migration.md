# First-workspace migration and idempotent cutover

Type: grilling
Status: claimed
Blocked by: 01, 02, 03, 09, 10, 11, 18

## Question

At the start of the new version we **queue an OpenWorkflow migration job** (same idea as the SCIP migration in `apps/backend/migrations/20260728140749_t08_enqueue_scip_migration_workflows`) so tenants need **no manual migration**.

**Locked assignment ([Workspace identity and invariants](18-project-identity-and-invariants.md)) — do not re-grill:**

- Each **connector target** becomes the workspace repository of a Workspace (display name defaults to that repo name).
- Ingested repos that are **not** a connector target **link** to the Workspace of the **first connector target**.
- If the org has **no** connector target, those repos stay **unlinked**. When an existing user opens the UI with no Workspace, **prompt to create a Workspace**; finishing create **automatically links** unlinked repositories.
- If linked repositories are git-canonical, that auto-link (and the migration link-to-first-connector-target) must **commit** `repositories/*.md` into the workspace tree (and ops-update `AGENTS.md` if `repositories/` is new), not only write Postgres. Locked by [Git-canonical knowledge and deterministic hydrate](02-hydration-contract.md).

Objects/claims/evidence today are org-scoped; repo identity lives in evidence keys, not a `workspace_id`.

Settle (assignment itself is locked):

- Sort key for **first** connector target (created-at? name? connection id?).
- How existing objects/claims are assigned **without** an LLM re-extract (which Workspace’s workspace tree they land in).
- What git commit(s) the job creates (export to the layout from [Knowledge Markdown and front-matter layout](03-knowledge-file-layout.md), via [Ingest-to-git write and concurrency protocol](10-ingest-to-git-write-protocol.md)).
- Import conflicts if the target repo already has knowledge files ([Workspace repository create, select, relink, and import](09-project-repository-lifecycle.md)).
- Idempotency: re-run mid-index, or when knowledge files already exist.
- Failure isolation: one tenant failing must not block others.
- Cutover visibility: tenants stay on old org-wide chat/graph until hydrate of the migration SHA succeeds?
- Prompt copy and when it fires (every session until a Workspace exists? dismissible?).

Recommend the dumbest remaining rules that do not drop data and do not invent a second source of truth.

## Comments

### From [Workspace repository create, select, relink, and import](09-project-repository-lifecycle.md)

Create/relink is any **member**. Auto-link of unlinked repos is a `repositories/*.md` commit in the **workspace repository** tree — paused if that workspace repository is read-only. Connector-target → workspace repository still holds; if the App cannot write that target, the new Workspace is read-only until access is fixed (installation admin adds the repo, etc.).

### Round 1 (asked, 2026-08-15)

Frontier: first-target sort; claim assignment; migration commits; existing `knowledge/` conflict; idempotency/isolation; cutover; prompt. Do not re-grill assignment of connector targets vs unlinked (18). Conversation drop/export stays [Workspace chat, conversation state, and sandbox security](13-project-chat-and-sandbox-security.md).

### Round 1 (human, 2026-08-15)

- **Q1:** Distinct target repository rows, `created_at` then `id`. Persist first Workspace id at migration start.
- **Q2:** Mechanical partition into `knowledge/imported/`. Repo id → that Workspace if it is the workspace repository, else first Workspace. No repo id → first. Cross-workspace claim skipped (objects kept). No target → dump on user create.
- **Q3:** Kind **migration export**, mechanical, one commit per Workspace (`knowledge/imported/**` + `repositories/*.md`). Then bootstrap. Mirrors not rewritten. Unwritable → pause.
- **Q4:** **Do not skip.** Same fact → **merge**. Name collision only → pick a different filename.
- **Q5:** **One OpenWorkflow per Workspace** (not per org). Isolate Workspaces, not only orgs.
- **Q6:** **Remove** legacy org-wide chat and graph. Reuse those components on the Workspace page (Workspace-scoped). No dual-read / legacy holdback.
- **Q7:** Blocking empty state; not permanently dismissible. Progress UI if migration is in flight.

## Answer

Human lock, 2026-08-15. No manual tenant migration. Do not re-grill [Workspace identity and invariants](18-project-identity-and-invariants.md) assignment. Writes follow [Ingest-to-git write and concurrency protocol](10-ingest-to-git-write-protocol.md). Hydrate/CAS follow [Workspace revision and derived-store freshness](11-project-revision-and-freshness.md). Conversation transcript fate is [Workspace chat, conversation state, and sandbox security](13-project-chat-and-sandbox-security.md).

### Workspaces the job creates

Each distinct **connector-target** repository becomes a Workspace (display name = repo name). Two connections bound to the same URL → one Workspace.

**First** target (unlinked ingested repos attach here): distinct target `repositories` rows, `created_at` then `id`. Persist that first Workspace id at migration start so a later binding does not move the set.

No connector target → no Workspace yet. [Workspace repository create, select, relink, and import](09-project-repository-lifecycle.md) create prompt; finishing create auto-links unlinked repos and runs the same export into that Workspace.

Unwritable target → Workspace exists, **read-only**, export paused until writable.

### Export (no LLM)

Partition existing objects/claims **mechanically** (dedup / evidence `repositoryId`):

- That repo is a workspace repository → that Workspace’s tree.
- Else → the **first** Workspace (repo is linked there).
- No repo id → first Workspace.
- Claim whose other end is not in this Workspace’s set → skip that claim; keep both objects.

Files go under `knowledge/imported/` (greenfield area). No `obj_` / SPO jargon in the file. Slug from payload title/name. Stable **`import_key`** (from today’s dedup / `logical_source_key`, not `obj_`) so re-runs and merges can find the same fact.

Kind **migration export**: mechanical (no agent). One commit per Workspace: the dump + `repositories/*.md` for that Workspace’s linked set. Then enqueue **bootstrap**. Do not rewrite `notion/` / `linear/` / `confluence/`.

### Conflict (existing `knowledge/`)

Do **not** skip and do **not** overwrite blindly.

- **Same fact** (`import_key` already present anywhere under `knowledge/`): **merge** into that file — union `claims[]` on `(to, predicate)` (keep higher confidence); if bodies differ, keep the existing body and append the imported body only if it is not already contained.
- **Name collision only** (path taken, different `import_key`): write a new filename (`slug-2.md`, then `-3`, …). Path is identity ([Git-canonical knowledge and deterministic hydrate](02-hydration-contract.md)).
- No collision: write the planned path.

### Workflows

**One OpenWorkflow per Workspace.** Creating the `ws_` rows + persisting first-Workspace id is a short version-start step; then enqueue. A failed export/hydrate retries **that** Workspace only. Sister Workspaces in the same org are unaffected. Persist job id → commit; re-run skips a Workspace whose export commit is already recorded. Orgs with no Workspace enqueue nothing until create.

### Cutover UI

**Remove** top-level org-wide Chat and Knowledge graph. Reuse those components on the Workspace page, scoped to the **active** projection ([Workspace revision and derived-store freshness](11-project-revision-and-freshness.md)). No legacy dual-read. Until a Workspace exists: Q7 empty state. Until export hydrates: graph/chat show whatever the tree already has (mirrors, existing files) — extracted rows not yet in git do not stay in an org-wide store.

### Prompt

Blocking empty state on first app navigation when the org has **zero** Workspaces. Not a toast. Not permanently dismissible. Copy: create a Workspace (select / `github.com/new` / paste); we will link existing indexed repos and import knowledge. Connector-target migration in flight → **progress**, not this prompt. Any **member** may create.
