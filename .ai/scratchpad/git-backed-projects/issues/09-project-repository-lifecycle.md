# Project repository create, select, relink, and import

Type: grilling
Status: open
Blocked by: 01, 02, 03, 18

## Question

How does a Project get, change, and import its **backing** git repository — including authorization and conflict policy? Attached codesearch repos are a different list; this ticket is the backing repo (knowledge + connectors). Attaching/detaching codesearch remotes is a **commit** of `repositories/*.md` in the backing tree ([Git-canonical knowledge and deterministic hydrate](02-hydration-contract.md)); folder add also ops-updates `AGENTS.md`.

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
