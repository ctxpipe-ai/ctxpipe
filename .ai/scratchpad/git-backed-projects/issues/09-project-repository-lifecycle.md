# Project repository create, select, relink, and import

Type: grilling
Status: claimed
Blocked by: 01, 02, 03, 18

## Question

How does a Project get, change, and import its **backing** git repository — including authorization and conflict policy? Attached codesearch repos are a different list; this ticket is the backing repo (knowledge + connectors). Attaching/detaching codesearch remotes is a **commit** of `repositories/*.md` in the backing tree ([Git-canonical knowledge and deterministic hydrate](02-hydration-contract.md)); merging that file **authorizes clone** (GitHub authz may reject; UI shows a human-friendly clone error). Folder add also ops-updates `AGENTS.md`. Indexes stay **per Project**.

**Locked by [Project identity and invariants](18-project-identity-and-invariants.md) — do not re-grill:** linking/creating the backing repo *is* Project create (no draft); any git URL is valid; GitHub has select-existing / create-new UX; a URL **backs at most one** Project; another Project may **attach** that same URL for search; display name defaults to the repo name and is editable (and is git-canonical in the root map).

The brief: in project settings the user configures the repository (select existing or pick new). When they change repository or create a Project and pick a repo **that already has content**, import that content and rebuild DB state. No manual migrations for the version cutover (that's [First-project migration and idempotent cutover](12-first-project-migration.md)); this ticket is the **ongoing** lifecycle.

Settle:

- Create: GitHub App “create new repo” vs select an existing installation repo vs paste a non-GitHub git URL — which of those ship in v1?
- Select existing: which repos are eligible (installation scope; already another Project’s **backing** repo is ineligible; already **attached** elsewhere is still eligible to back?)
- Relink: Project currently on repo A, user picks repo B. What happens to knowledge files on A? Copy, move, leave, or refuse if A has files?
- Import: hydrate from B's knowledge layout. If B has knowledge files **and** the Project still has Postgres rows from A, which wins? Refuse, merge, or replace?
- When does the rebuilt DB become visible (atomic switch at a git SHA)?
- Who may create/relink (org role)?
- Empty repo vs repo with unrelated files vs repo with our layout.

Recommend the fewest operations: attach-or-create, hydrate-replace on import, refuse relink when it would fork two sources of truth. Name any extra operation you keep and why.

## Comments

### Round 1 (human, 2026-08-14)

- **Q1:** All three surfaces (select GitHub, create GitHub, paste URL). Create should be **in-product**, not `github.com/new`. Facts: [GitHub App create-repo permissions](../assets/github-app-create-repo-permissions.md) — GitHub requires Repository **Administration: write**; IAT works for GitHub **org** installs; user-account installs need a user token we do not mint today.
- **Q2:** Any org **member** may create (and, pending Q9, relink). Future per-Project sharing is later. Org-wide knowledge is gone; knowledge is Project-scoped ([Git-canonical knowledge and deterministic hydrate](02-hydration-contract.md)).
- **Q3:** A URL already **attached** elsewhere is still eligible to **back** a Project. Human: that is how to stack “sub projects.” Restate next round: no `parent_id`; stacking = attach another Project’s backing URL for search.
- **Q4:** No git merge/copy/move. Changing backing means the Project (a projection) follows the new remote. Agents/git can move files if the user wants. Relink mechanics (`proj_` id, conversations) still open.
- **Q5:** As recommended. Empty: bootstrap not required for hydrate. Unrelated: do not dump a parallel tree. Our layout: hydrate as-is. Serving stores live on first successful hydrate SHA; chat/graph wait for that.

### Round 2 (human, 2026-08-14)

- **Q6:** Confirmed the tradeoff — `github.com/new` exists so the App does **not** need Repository Administration:write. **Option 2:** stay on external create + select. No `repos.create`.
- **Q7:** Same `proj_` id, conversations, settings; relink is a new backing pointer + new projection. No git merge.
- **Q8:** Keep conversations.
- **Q9:** Any member may relink any Project in the org. Per-Project sharing is later.
- **Q10:** Thin bootstrap (`AGENTS.md` + knowledge skill) also runs when **selecting an existing** repo, not only create-new. Overwrite-vs-fill and non-writable remotes still open.
- **Q11:** Attach-only. No `parent_id`. “Sub project” is not an aggregate.

### Round 3 (human, 2026-08-14) — answered attached vs backing; backing fill/fail still open

Human used “linked repo” for **attached** (codesearch) remotes. Glossary term stays **attached**, not linked.

- Bootstrap / `AGENTS.md` / knowledge skill apply only to the **backing** repo. Hydrate does not write git at all ([Git-canonical knowledge and deterministic hydrate](02-hydration-contract.md)); it never touches attached working trees. Attaching is a `repositories/*.md` commit **in the backing tree**, not a write into the attached remote.
- Q12/Q13 as asked were about the **backing** remote (select-existing / paste / cannot-push). Restate those two for backing only.
