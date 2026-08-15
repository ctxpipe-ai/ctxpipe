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

### Round 3 (human, 2026-08-15)

- **Q15:** Slug unique per org. Default GitHub repo name, or last path segment for other git URLs. Collision suffix `-2`, `-3`. Set at create; editable in workspace settings; relink does not change it. Display name stays AGENTS.md `name` and may differ. Slug is on the `ws_` row, not in git.
- **Q16:** `?pane=` is a string id: `files` | `graph` | `settings` | `file:<path>`. Future tabs are new ids. Unknown ids stay in the URL; UI ignores them. Close drops `pane`. Maximise is local, not in the URL.
- **Q17:** Bare `/$orgSlug/ws/$workspaceSlug` is always a **new composer**. First message creates the thread. (Supersedes Q4/Q8 “row immediately”.)
- **Q18:** Org settings gets a product Workspaces section (list + Add, ticket 09 flows). Not inside the Better Auth members card.
- **Q19:** After sign-in, last-used Workspace + new composer. First message creates the conversation in the menu.

## Answer

Draft — waiting Sol review and human confirm. Visual polish is not part of this lock. Prototype: [Workspace UI prototype](15-project-workspace-ui-prototype.md).

### Nav

Top-level: **Home**, **Search** (command palette, not a page), **Connectors**, then workspace rows. No top-level Chat, Knowledge graph, or Repositories. Org/account chrome stays.

Each workspace row: folder + display name + new-chat icon. `n=1`: always expanded, folder only, no caret; title click = new composer (same as the icon). `n>1`: folder at rest; hover title → caret; title click on the **current** Workspace toggles last-5 only; title click on a **different** Workspace selects it and opens its most recent conversation (new composer if it has none). Conversations: last 5, **Load more** adds 5. Light indent. No Workspaces section heading.

### Create Workspace

Create is link (ticket 09 / 18). Surfaces: (1) first-run onboarding includes a Workspace-create step; (2) any org with **zero** Workspaces — including migrants who already finished `/onboarding` — is redirected to that create step, not the completed-user carousel; (3) **Add Workspace** lives in **org settings** (product Workspaces section: list + Add). Not in the workspace Settings pane, not in the nav.

### URLs

- `/$orgSlug/ws/$workspaceSlug` — Workspace, new composer, no thread yet.
- `/$orgSlug/ws/$workspaceSlug/$conversationId` — that conversation.
- `?pane=<id>` — open pane tab. Built-ins: `files`, `graph`, `settings`, `file:<path>` (encoded path). Later tabs add ids. Unknown ids are kept; the UI ignores them. Closing the pane removes `pane`. Maximise is not in the URL.

**Workspace slug:** unique per Organisation. Default = GitHub repo name, or last path segment of any other git URL. Collision: `-2`, `-3`. Set at create; editable in workspace settings; relink does not change it. Distinct from display name (`AGENTS.md` `name`). Stored on the `ws_` row, not in git.

Kill `/$orgSlug/chat`, `/$orgSlug/repositories`, `/$orgSlug/knowledge-graph`. No compatibility redirects.

After sign-in (org already has Workspaces): last-used Workspace + new composer (`/$orgSlug/ws/$slug`). If that Workspace is gone: another Workspace or the create gate. Home stays a page; it is not the default landing.

### Conversation

New composer (new-chat icon, n=1 title, bare workspace URL, post-sign-in): **no row** until the first user message. That message creates the conversation, inserts it at the top of that Workspace’s list, and navigates to `.../$conversationId`. Then one-shot model title from that message. User can rename later. Header always shows the conversation name (ticket 14). Previous conversations stay (idle per ticket 14). Clicking a conversation opens it.

### Right pane

One workspace surface: centre chat + optional pane. Closable, resizable, maximisable (hides chat; click title restores). Files / Graph / Settings are pane tabs, not routes.

**Files:** single-click preview, tree stays open; Hide/Show tree only after a file is selected; double-click opens a closeable named tab (`?pane=file:<path>`). Diff later.

**Graph (v1):** this Workspace’s projection, not org-wide. Conversation-scoped Graph is later.

**Workspace Settings pane:** this Workspace only — workspace repository create/select/relink (ticket 09), linked remotes, read-only reason. Org **Connectors** stays the org Connectors page. Add Workspace is org settings, not this pane.
