# Workspace repository create, select, relink, and import

Type: grilling
Status: resolved
Blocked by: 01, 02, 03, 18

## Question

How does a Workspace get, change, and import its **workspace repository** — including authorization and conflict policy? Linked codesearch repos are a different list; this ticket is the workspace repository (knowledge + connectors). Linking/unlinking codesearch remotes is a **commit** of `repositories/*.md` in the workspace tree ([Git-canonical knowledge and deterministic hydrate](02-hydration-contract.md)); merging that file **authorizes clone** (GitHub authz may reject; UI shows a human-friendly clone error). Folder add also ops-updates `AGENTS.md`. Indexes stay **per Workspace**.

**Locked by [Workspace identity and invariants](18-project-identity-and-invariants.md) — do not re-grill:** linking/creating the workspace repository *is* Workspace create (no draft); any git URL is valid; GitHub has select-existing / create-new UX; a URL is the workspace repository of at most one Workspace; another Workspace may **link** that same URL for search; display name defaults to the repo name and is editable (and is git-canonical in the root map).

The brief: in project settings the user configures the repository (select existing or pick new). When they change repository or create a Workspace and pick a repo **that already has content**, import that content and rebuild DB state. No manual migrations for the version cutover (that's [First-workspace migration and idempotent cutover](12-first-project-migration.md)); this ticket is the **ongoing** lifecycle.

Settle:

- Create: GitHub App “create new repo” vs select an existing installation repo vs paste a non-GitHub git URL — which of those ship in v1?
- Select existing: which repos are eligible (installation scope; already another Workspace’s **workspace repository** is ineligible; already **linked** elsewhere is still eligible to become the workspace repository?)
- Relink: Workspace currently on repo A, user picks repo B. What happens to knowledge files on A? Copy, move, leave, or refuse if A has files?
- Import: hydrate from B's knowledge layout. If B has knowledge files **and** the Workspace still has Postgres rows from A, which wins? Refuse, merge, or replace?
- When does the rebuilt DB become visible (atomic switch at a git SHA)?
- Who may create/relink (org role)?
- Empty repo vs repo with unrelated files vs repo with our layout.

Recommend the fewest operations: attach-or-create, hydrate-replace on import, refuse relink when it would fork two sources of truth. Name any extra operation you keep and why.

## Comments

### Round 1 (human, 2026-08-14)

- **Q1:** All three surfaces (select GitHub, create GitHub, paste URL). Create should be **in-product**, not `github.com/new`. Facts: [GitHub App create-repo permissions](../assets/github-app-create-repo-permissions.md) — GitHub requires Repository **Administration: write**; IAT works for GitHub **org** installs; user-account installs need a user token we do not mint today.
- **Q2:** Any org **member** may create (and, pending Q9, relink). Future per-Workspace sharing is later. Org-wide knowledge is gone; knowledge is Workspace-scoped ([Git-canonical knowledge and deterministic hydrate](02-hydration-contract.md)).
- **Q3:** A URL already **linked** elsewhere is still eligible to **back** a Workspace. Human: that is how to stack “sub projects.” Restate next round: no `parent_id`; stacking = attach another Workspace’s workspace URL for search.
- **Q4:** No git merge/copy/move. Changing the workspace repository means the Workspace (and its projection) follows the new remote. Agents/git can move files if the user wants. Relink mechanics (`ws_` id, conversations) still open.
- **Q5:** As recommended. Empty: bootstrap not required for hydrate. Unrelated: do not dump a parallel tree. Our layout: hydrate as-is. Serving stores live on first successful hydrate SHA; chat/graph wait for that.

### Round 2 (human, 2026-08-14)

- **Q6:** Confirmed the tradeoff — `github.com/new` exists so the App does **not** need Repository Administration:write. **Option 2:** stay on external create + select. No `repos.create`.
- **Q7:** Same `ws_` id, conversations, settings; relink is a new workspace-repository pointer + new projection. No git merge.
- **Q8:** Keep conversations.
- **Q9:** Any member may relink any Workspace in the org. Per-Workspace sharing is later.
- **Q10:** Thin bootstrap (`AGENTS.md` + knowledge skill) also runs when **selecting an existing** repo, not only create-new. Overwrite-vs-fill and non-writable remotes still open.
- **Q11:** Attach-only. No `parent_id`. “Sub project” is not an aggregate.

### Round 3 (human, 2026-08-14) — answered linked vs workspace repository; fill/fail still open

Human used “linked repo” for **linked** (codesearch) remotes. Glossary term stays **linked**, not linked.

- Bootstrap / `AGENTS.md` / knowledge skill apply only to the **workspace repository**. Hydrate does not write git at all ([Git-canonical knowledge and deterministic hydrate](02-hydration-contract.md)); it never touches linked working trees. Linking is a `repositories/*.md` commit **in the workspace tree**, not a write into the linked remote.
- Q12/Q13 as asked were about the **workspace repository** remote (select-existing / paste / cannot-push). Restate those two for the workspace repository only.

### Round 4 (human, 2026-08-14)

- **Q12 (workspace repository):** Not fill-if-missing and not a blind overwrite. On create / select-existing / relink, an **agent** ensures `AGENTS.md` and the knowledge skill: append to existing `AGENTS.md`; if a skill already exists, **merge and polish**. Still workspace-repository only; no `knowledge/` dump; linked remotes untouched. Same ops `chat()` (unsandboxed) as folder-map updates ([Git-canonical knowledge and deterministic hydrate](02-hydration-contract.md)); commit mechanics on [Ingest-to-git write and concurrency protocol](10-ingest-to-git-write-protocol.md). Scope of polish: `.agents/skills/ctxpipe-knowledge/` (+ editor symlinks from layout); other skills left alone; `AGENTS.md` keeps unrelated customer instructions ([Knowledge Markdown and front-matter layout](03-knowledge-file-layout.md)).
- **Q13 (workspace repository):** Create/relink + hydrate still happen if the tree is readable. Failure to **write** the workspace remote is a **read-only Workspace**: UI must say so, with a tooltip whose fix steps match that error (not in installation, no Contents:write, protected branch, non-GitHub URL without credentials, …). Not a failed create. How chat behaves while read-only is Q14.

### Round 5 (human, 2026-08-14)

- **Q14:** Option 1. Hydrate, search, and workspace chat continue (sandbox may dirty the clone; no commit/push to the workspace remote). **Every job whose purpose is to maintain/update that workspace repository is paused** (bootstrap/ops `AGENTS.md`+skill, ingest commits, connector mirrors into this workspace repository, maintenance/rename-rewrite). Relink still allowed. Resume when the remote is writable — probe/retry on [Ingest-to-git write and concurrency protocol](10-ingest-to-git-write-protocol.md). Push/commit of sandbox dirty trees: [Worktree and agent-change lifecycle](14-worktree-and-agent-change-lifecycle.md).

Sol: first draft **revise**; second pass **revise** (drop editor skill symlinks from the bootstrap allowlist); third pass **accept**.

## Answer

Human lock, 2026-08-14. Sol review: first two drafts **revise**; third pass **accept**. Human Q1–Q14 kept with honest mechanics (desired vs active projection, durable write/hydrate status, bounded bootstrap).

**Who.** Any org **member** may create a Workspace and **relink** any Workspace in the org. Per-Workspace sharing is later. Knowledge is Workspace-scoped; there is no org-knowledge ACL. GitHub App **installation** (connect the App, change repository selection) stays **admin or owner** as today. Footgun, not a hidden admin check: any member’s relink replaces the org-visible projection and keeps the same `ws_` id.

**Create (v1) — three surfaces**

1. **Select** an existing GitHub repo the **installation can see**.
2. **Create** via guided `github.com/new`, then select. The App does **not** call `repos.create` and does **not** take Repository Administration:write ([GitHub App create-repo permissions](../assets/github-app-create-repo-permissions.md)).
3. **Paste** any git URL.

After `github.com/new` on a **selected-repositories** install, an **installation owner/admin** must add the repo to the App (manage-installation URL). Any member can refresh the picker; we do not create a draft Workspace while they wait. If they paste/select a URL we can clone but not push, create still succeeds and the Workspace is **read-only**.

**Eligibility.** A URL may back a Workspace iff it is **not already the workspace repository of** another Workspace in this org (same uniqueness grain as today’s `repositories.git_url` / org). Already **linked** elsewhere, **unlinked**, or a **connector target** does not disqualify it. GitHub picker lists installation-accessible repos only; paste covers the rest. No `parent_id`. Stacking is [Workspace identity and invariants](18-project-identity-and-invariants.md): Workspace P **links** Workspace C’s workspace URL for codesearch. C is a normal Workspace.

**Relink — pointer vs projection.** Same `ws_`. Conversations and settings stay. **No** git copy/move/merge; A’s tree is left as-is (the user’s agent can migrate files).

Store **desired** workspace repository (URL + generation) separately from **active** projection `{url, sha}`:

1. Relink sets **desired = B** and bumps generation immediately.
2. Serving stays on **A** until hydrate of B succeeds, then **atomically** activate B and B’s linked set (`repositories/*.md` on that SHA). Hydrate contract: previous SHA stays live until the new projection succeeds.
3. Write jobs carry the generation and **recheck** before push: they target **desired** B, never stale A. If B is unwritable, those jobs are paused (below).
4. Display name: hydrate copies B’s `AGENTS.md` `name` if present; else keep last known. Sandbox snapshot keys include workspace URL + stored SHA ([Workspace revision and derived-store freshness](11-project-revision-and-freshness.md)) — they invalidate on this switch.

**Import / bootstrap.** Hydrate the workspace tree **as-is** (skip malformed; empty → empty serving store). Never invent `knowledge/` units. Never write **linked** remotes. Hydrate never writes git.

On create, select-existing, and relink, enqueue the **bootstrap** job ([Ingest-to-git write and concurrency protocol](10-ingest-to-git-write-protocol.md)). It uses the write sandbox when a provider exists; Fargate v1 stays unsandboxed. Allowed diffs only: root `AGENTS.md` (front matter `name` + **one** folder-structure section; do not rewrite unrelated instructions) and `.agents/skills/ctxpipe-knowledge/**` (create, or merge-and-polish). Bootstrap **never** creates or modifies editor-specific skill symlink directories (`.claude/skills`, … — those remain [Knowledge Markdown and front-matter layout](03-knowledge-file-layout.md) / later write jobs). Out-of-scope edits are rejected. Bootstrap failure **does not** block hydrate.

Serving stores (and chat/graph against them) go live at the **first successful hydrate SHA**. Distinct from write status.

**Read-only Workspace.** Two durable statuses (not process memory):

- **`hydrate_status`:** can we read/activate this desired SHA?
- **`write_status`:** can ctxpipe commit/push to the desired workspace repository? Persist error code + remediation string for the tooltip.

Readable + unwritable → Workspace exists, hydrates, chrome **read-only**, tooltip = that error and the fix (not in installation, need installation admin to add the repo, no Contents:write, pasted host without credentials, protected branch, …). Unreadable tree → hydrate-failed, not read-only.

While `write_status` is not writable, **pause** write intents for the **current generation** whose purpose is to maintain/update **this workspace URL**:

- ops/bootstrap `AGENTS.md` + skill
- ingest commits to this workspace repository
- connector **destination mirrors into this URL only** (org source polling, webhooks, cursors, and mirrors to **other** destinations keep running)
- claims upgrade, rename rewrite, `valid_from` persist, semantic merge
- link/unlink (`repositories/*.md` commits in this workspace repository)

**Not paused:** hydrate, codesearch, workspace chat (sandbox may dirty the clone; **no** commit/push to the remote), relink. Resume the paused intents for this generation when `write_status` becomes writable — probe/retry on [Ingest-to-git write and concurrency protocol](10-ingest-to-git-write-protocol.md). Sandbox dirty-tree disposition: [Worktree and agent-change lifecycle](14-worktree-and-agent-change-lifecycle.md).

**Rejected.** In-product `repos.create` / Administration:write. Relink copy/move/merge. `parent_id` / “sub project” aggregate. Writing linked remotes. Failing create because bootstrap cannot push. Admin-only Workspace create.
