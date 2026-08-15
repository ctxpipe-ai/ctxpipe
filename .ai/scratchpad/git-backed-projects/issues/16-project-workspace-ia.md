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

### Round 2 (human, 2026-08-15)

- **Q6:** Workspace-create step (ticket 09 flows) in first-run onboarding. Zero-Workspace orgs — including migrants who already finished `/onboarding` — redirect there. Not the completed-user carousel.
- **Q7:** n>1 title on a **different** Workspace selects it and opens its most recent conversation (empty composer if none). Title on the **current** Workspace only toggles the list.
- **Q8:** n=1 title click = new-chat icon: new row, selected.
- **Q9:** Short model title from the first user message, once that turn is in. One shot. User can still rename. Header shows the conversation name.
- **Q10:** Workspaces have **slugs** (default GitHub repository slug) in the path: `/$orgSlug/ws/$workspaceSlug` and `/$orgSlug/ws/$workspaceSlug/$conversationId`. Pane is a query param; it must cover Files / Graph / Settings **and file tabs**, and stay open for future tabs.
- **Q11:** Pane closable (clears `pane`). Maximisable (hides chat; title restores). Resizable.
- **Q12:** Single-click preview, tree stays open. Hide/Show tree only after a file is selected. Double-click opens a closeable named tab. Diff later.
- **Q13:** Workspace Settings pane = this Workspace only (workspace repository, linked remotes, read-only reason, …). **Add Workspace and other org-level settings live in org settings** — not in the workspace pane. (This narrows round-1 Q3 “Settings”.)
- **Q14:** Kill `/$orgSlug/chat`, `/$orgSlug/repositories`, `/$orgSlug/knowledge-graph`. No redirects.
