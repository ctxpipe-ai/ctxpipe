# Project workspace UI prototype

Type: prototype
Status: open
Blocked by: 01, 07, 09, 13, 14

## Question

What should the **project workspace** look and feel like, as a cheap prototype we can react to — not the production app?

Prompt for the prototype (not locked IA; locking is [Project workspace IA and interaction contract](16-project-workspace-ia.md)):

- **Projects** section under current nav items.
- Header "Projects" with a (+) on the right, shown on hover, that adds a project.
- Each project: dropdown chevron on the right reveals the **last 5 conversations**.
- Clicking the project opens that project's chat.
- New conversation is named and inserted at the top of that list.
- Remove the current chat conversation list and the UI/MCP source selector.
- Top-level Chat and Knowledge graph pages go away (chat + graph live on the project page).
- Active project: **top-right buttons** switch right-panel tabs — **files** (tree + preview; double-click opens another tab of the same type; tree collapsible when a file is selected), **graph**, **settings** (create/select/relink repo). Diff tab later, not now.
- Show a friendly **sandbox/session name** in the chrome (not a host git-worktree path — see [Chat uses TanStack sandbox, not DIY OpenCode](17-tanstack-sandbox-not-diy-opencode.md)).
- Coding-agent desktop chrome is the visual reference — [Coding-agent desktop UI reference](07-coding-agent-desktop-ui-reference.md).
- Empty states: no projects; Project whose repo lifecycle is still draft **only if** [What is a Project](01-what-is-a-project.md) allows drafts; repo with no conversations.
- Remaining Home / Repositories / Connectors: show a proposal, do not silently delete them.

Link the prototype from this ticket. Do not build production routes. The human reacts here; [Project workspace IA and interaction contract](16-project-workspace-ia.md) records the decision.
