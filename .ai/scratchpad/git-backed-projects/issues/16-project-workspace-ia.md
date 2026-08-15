# Workspace IA and interaction contract

Type: grilling
Status: claimed
Blocked by: 15

## Question

After reacting to [Workspace UI prototype](15-project-workspace-ui-prototype.md), lock the information architecture and interaction contract for the production UI.

Settle:

- Nav: Workspaces list vs Home, Repositories, Connectors. What remains top-level?
- Click vs chevron on a Workspace row (open chat vs last-5 conversations).
- New conversation: when it is named, where it appears, what happens to the previous session.
- Right-panel tabs: files / graph / settings — defaults, URL deep-linking, whether the panel is closable.
- File browser: single-click preview vs double-click tab; tree collapse rule.
- Settings: the create/select/relink flows from [Workspace repository create, select, relink, and import](09-project-repository-lifecycle.md) — which of those are in this panel vs elsewhere.
- Worktree name placement.
- Connector settings: org-level Connectors page vs per-project settings.
- Graph tab: the current org-wide graph, or workspace-scoped hydrate of that Workspace only?

This is the decision. The prototype is evidence. Do not reopen visual polish here.

## Comments

### Claimed (2026-08-15)

Round 1 frontier. Already locked elsewhere — do not re-grill: no top-level Chat or Knowledge graph ([First-workspace migration and idempotent cutover](12-first-project-migration.md)); conversation name is the chrome label ([Worktree and agent-change lifecycle](14-worktree-and-agent-change-lifecycle.md)); create/select/relink and read-only ([Workspace repository create, select, relink, and import](09-project-repository-lifecycle.md)); many Workspaces per org ([Workspace identity and invariants](18-project-identity-and-invariants.md)); no per-workspace subnav ([Workspace UI prototype](15-project-workspace-ui-prototype.md)). Pane URL, file-tree rules, and settings field placement wait on the page-model answer.

### Round 1 (human, 2026-08-15)

- **Q1:** Home, Search, Connectors, then workspace rows. No top-level Chat, Knowledge graph, or Repositories. Linked remotes in workspace settings. Org/account chrome stays.
- **Q2:** Title click toggles last-5 when `n>1`. Title click opens a **new chat** when `n=1`. (Centre behaviour when toggling another workspace, and whether every n=1 title click creates a thread, are round 2.)
- **Q3:** Add Workspace in **onboarding** and in **Settings**. Migrating users with no Workspace are redirected to onboarding. (What “onboarding” is vs today’s `/onboarding` user carousel is round 2.)
- **Q4:** New-chat creates a row immediately, titled “New conversation”, inserted at the top, selected. Previous conversation stays. **Auto-rename after the first message.**
- **Q5:** One workspace surface: centre chat + optional right pane (Files / Graph / Settings). Open pane is in the URL (query param is fine). Graph v1 is this Workspace’s projection. Conversation-scoped Graph is later.
