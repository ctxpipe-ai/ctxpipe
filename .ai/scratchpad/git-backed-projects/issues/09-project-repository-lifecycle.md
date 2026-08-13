# Project repository create, select, relink, and import

Type: grilling
Status: open
Blocked by: 01, 02, 03, 18

## Question

How does a Project get, change, and import its GitHub repository — including authorization and conflict policy?

The brief: in project settings the user configures the repository (select existing or pick new). When they change repository or create a Project and pick a repo **that already has content**, import that content and rebuild DB state. No manual migrations for the version cutover (that's [First-project migration and idempotent cutover](12-first-project-migration.md)); this ticket is the **ongoing** lifecycle.

Settle:

- Create: is "new Project" = create GitHub repo via the App, or also attach an existing repo?
- Select existing: which repos are eligible (installation scope, already another Project's backing repo)?
- Relink: Project currently on repo A, user picks repo B. What happens to knowledge files on A? Copy, move, leave, or refuse if A has files?
- Import: hydrate from B's knowledge layout. If B has knowledge files **and** the Project still has Postgres rows from A, which wins? Refuse, merge, or replace?
- When does the rebuilt DB become visible (atomic switch at a git SHA)?
- Who may create/relink (org role)?
- Empty repo vs repo with unrelated files vs repo with our layout.

Recommend the fewest operations: attach-or-create, hydrate-replace on import, refuse relink when it would fork two sources of truth. Name any extra operation you keep and why.
