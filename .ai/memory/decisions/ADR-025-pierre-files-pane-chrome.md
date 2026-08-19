# ADR-025: Pierre trees and diffs as Workspace Files explorer chrome

**Status:** Accepted | **Date:** 2026-08-19 | **Tags:** ui, workspaces, git

## Context

The Workspace Files pane started as a homemade React Aria `Tree` plus a `<pre>` preview of hydrated knowledge `.md` files. That explorer needed search, flatten, git status, diffs, edit, and mutations. Growing it in-house would duplicate a path-first file tree and a syntax-highlighted editor.

`@pierre/trees` and `@pierre/diffs` (Apache-2.0) already provide that chrome. Persist must still follow workspace write jobs: in-sandbox worktree, at most one commit on the default branch, then push and hydrate. The pane is a **workspace-repository** explorer (full git tree at the projection SHA), not hydrate units only. Graph stays on hydrate knowledge.

React Aria remains the house primitive for product chrome. Pierre paints the tree and file surfaces in Shadow DOM — the same class of exception as Cosmograph.

## Decision

Use **`@pierre/trees`** (`FileTree`, search, flatten, git badges, DND, rename) and **`@pierre/diffs`** (`File`, `FileDiff`, `EditProvider`) as Files pane chrome only.

- Read the git tree, blobs, and status through org-scoped routes: `GET /{workspaceSlug}/files/tree`, `GET /{workspaceSlug}/files/blob?path=`, and `GET /{workspaceSlug}/files/status`. SHA is `activeProjectionSha`, then `desiredSha`. Status is porcelain from the write sandbox when one is attached; otherwise all-clean vs that SHA. Non-GitHub remotes and missing App connections return 409 with existing write-status reasons. `GET /{workspaceSlug}/files` stays the hydrate knowledge listing for Graph.
- Persist edits and structure mutations only via `POST /{workspaceSlug}/files/jobs`, which enqueues a `ui_file_edit` write job (`mergeFiles` / `mergeDeletePaths`, in-sandbox worktree). Do not GitHub-API-commit from the UI. Read-only Workspaces browse and may edit locally, but Save and mutating menu items are disabled.
- Context menus stay React Aria; do not restyle Pierre rows with Tailwind.
- Map Pierre CSS variables to house zinc / card / quiet focus. Tabler icons stay on pane chrome, not inside the tree.

## Consequences

- Files pane ARIA for the tree is Pierre’s, not RAC Tree. Keyboard and focus must be checked in Storybook, not assumed from RAC lessons.
- UI must not treat hydrate `.md` paths as the full repo. Story fixtures are git-shaped and include `AGENTS.md`.
- Shadow DOM theming is CSS variables on the host, not utility classes on rows.
- `useFileTree` is create-once: later tree and status updates go through `resetPaths` / `setGitStatus`, not hook option changes.

## Alternatives Considered

- Keep growing the RAC tree and `<pre>` preview: rejected; the feature set already exists in Pierre.
- Knowledge-only explorer (hydrate `.md` units): rejected; the Files pane is the workspace repository.
- Commit via GitHub Contents API from the UI: rejected; write jobs are the persist boundary.
