# Workspace UI prototype

Type: prototype
Status: claimed
Blocked by: 01, 07, 09, 13, 14

## Question

What should the **Workspace** look and feel like, as a cheap prototype we can react to — not the production app?

Prompt for the prototype (not locked IA; locking is [Workspace IA and interaction contract](16-project-workspace-ia.md)):

- **Workspaces** section under current nav items.
- Header "Workspaces" with a (+) on the right, shown on hover, that adds a Workspace.
- Each Workspace: dropdown chevron on the right reveals the **last 5 conversations**.
- Clicking the Workspace opens that Workspace's chat.
- New conversation is named and inserted at the top of that list.
- Remove the current chat conversation list and the UI/MCP source selector.
- Top-level Chat and Knowledge graph pages go away (chat + graph live on the workspace page).
- Active Workspace: **top-right buttons** switch right-panel tabs — **files** (tree + preview; double-click opens another tab of the same type; tree collapsible when a file is selected), **graph**, **settings** (create/select/relink repo). Diff tab later, not now.
- Show the **conversation name** in the chrome ([Worktree and agent-change lifecycle](14-worktree-and-agent-change-lifecycle.md)) — not a host path or raw `threadId`.
- Coding-agent desktop chrome is the visual reference — [Coding-agent desktop UI reference](07-coding-agent-desktop-ui-reference.md).
- Empty states: **no draft Workspace** ([Workspace identity and invariants](18-project-identity-and-invariants.md)). Existing user with no Workspace: **prompt to create a Workspace**; finishing create auto-links unlinked repos. Also: Workspace with no conversations.

- Remaining Home / Repositories / Connectors: show a proposal, do not silently delete them.

Link the prototype from this ticket. Do not build production routes. The human reacts here; [Workspace IA and interaction contract](16-project-workspace-ia.md) records the decision.

**Locked by [Workspace repository create, select, relink, and import](09-project-repository-lifecycle.md):** settings create/select/relink (any member); create-new is `github.com/new` then select + refresh (installation admin adds selected repos); paste URL; **read-only** chrome with an error-specific tooltip; no draft while waiting on GitHub. Auto-link on first create still applies; it is paused if the new workspace repository is unwritable.

## Comments

### Claimed (2026-08-15)

Throwaway route (no auth): [`/.workspace-ui-prototype`](../../../apps/ui/src/routes/[.]workspace-ui-prototype.tsx). Run `pnpm --filter @ctxpipe/ui prototype:workspace-ui` then open that path. `?variant=A|B|C` and `?scene=populated|one-ws|empty-org|empty-ws|readonly`.

Three structurally different variants (not colour tweaks):

- **A — Nested last-5:** ticket prompt. Home / Repositories / Connectors stay. Workspaces section with hover (+). Chevron reveals last 5. Click row opens chat. Top-right Files / Graph / Settings. File tree + preview; double-click opens a tab; tree collapses on select.
- **B — Work queue:** Codex-like. Conversations always listed under each Workspace (no last-5 chevron). Org pages demoted to a drawer. Right pane is **Code changes | Graph | Settings** — no explorer.
- **C — Single workspace:** Claude-like. One Workspace at a time via switcher. Unbounded Recents. Files / Graph / Settings are a closable slide-over or command palette. Icon rail keeps Home / Repositories / Connectors.

Stub data only. Human reacts here; [Workspace IA and interaction contract](16-project-workspace-ia.md) locks the contract.

### Round 1 (human, 2026-08-15)

Steal-bits from A + C. Recorded in variant **A — Chosen chrome** (B/C remain for comparison):

- Nav like A. No top-level Repositories — linked remotes live in Workspace settings.
- Workspace row click toggles last-5 (caret at the start). `+` on the right starts a conversation. **Load more** adds another 5 while any remain.
- Search (⌘K) sits with Home and Connectors.
- Composer is a floating rich input.
- Right pane: resizable, closeable, maximisable (hides chat; title restores). Tabs at the start of the pane. File tree closeable only after a file is selected — not auto-closed. Double-click opens a closeable file tab.

### Round 2 (human, 2026-08-15)

Nav chrome tweak on chosen A, after roast:

- Muted **Workspaces** section label. Keep the heading even when n=1.
- Folder icon when the row is not collapsible. `n=1` is always expanded, folder only, collapse disabled. `n>1`: folder by default; hover the workspace title to swap the icon for a caret; click toggles.
- Home / Connectors / Search and workspace titles share one row recipe (icon, label, optional trailing). Not pixel-identical — iterate after seeing it.
- Keep `+` on the Workspaces header (do not bury create in settings). Shown at rest, same trailing slot as Search / new conversation — hover-only was too easy to miss on this chrome.
- Keep the section hierarchy for now. If it still conflicts, later move Add Workspace and drop the header.
- Scene `one-ws` for comparing n=1 vs n>1.
