# Add a second Workspace from the UI

Status: done
Priority: P1
Owner: claude
Blocked by: none
Created: 2026-10-02
Updated: 2026-10-02

## Context

The locked IA ([workspaces PRD](../../../memory/PRDs/workspaces.md) § UI) puts **Add Workspace** in organization settings and in the zero-Workspace gate. A sidebar "+" was removed on purpose (`0e8a3844e`, "SideNav no longer creates workspaces"). Organization settings never got the entry, though.

Today an organization that already has a Workspace can only create another one through:

- the GitHub connector wizard (`GithubWorkspaceDestination` → **Create workspace**), or
- typing `/<org>/workspaces/new`.

Home's **Create a workspace** button shows only when no Workspace is selected. `WorkspaceCreateModal` exists but nothing renders it.

Organization settings mixes Better Auth UI's `OrganizationView` (Settings, Members; it renders its own nav) with our custom API Keys view (`OrganizationSettingsNav`). A Workspaces tab there has to appear in both navs.

## Goal

A member can add another Workspace from an obvious place without going through GitHub setup.

## Acceptance criteria

- [ ] An entry point that matches the user's choice below opens the existing create form (`WorkspaceCreateForm` / `WorkspaceCreateModal`).
- [ ] A Storybook play opens it and creates a Workspace (MSW).
- [ ] Public docs (`workspaces/create-workspace.mdx`) name the entry point.
- [ ] `WorkspaceCreateModal` is used or deleted.

## Plan

1. User picks the entry point.
2. Build it with the product-ui and React skills, plus a story play.
3. Update the docs page.

## Open questions

- Where should Add Workspace live?
  - **A. Organization settings → Workspaces tab** (as the PRD says). Lists Workspaces, with an **Add Workspace** button. It needs a Better Auth UI nav override so the tab shows on every settings view.
  - **B. ⌘K palette action "Add Workspace".** Smallest change, but hard to discover.
  - **C. A and B.**

## Delegation brief

Read the PRD § UI, `routes/$orgSlug.organization.$organizationView.tsx`, `features/organization/OrganizationSettingsNav.tsx`, `providers/AuthProvider.tsx` (organization settings config), `features/workspaces/WorkspaceCreateModal.tsx`, and `WorkspaceCommandPalette.tsx`. Do not bring back a sidebar "+".

## Comments

- 2026-10-02 (claude): found while rewriting public docs (ticket 07 row 11). The docs currently name the paths that exist today.

## Resolution

User decision (2026-10-02): a **+** next to the Workspaces label in the left nav. `WorkspaceNavList` renders it and opens `WorkspaceCreateModal`. Story `AddWorkspace` play opens the dialog. Docs and PRD updated.
