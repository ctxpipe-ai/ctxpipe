# ADR-026: Pierre trees and diffs as Workspace Files explorer chrome

**Status:** Accepted | **Date:** 2026-08-19 | **Tags:** ui, workspaces, git

## Context

The Workspace Files pane started as a homemade React Aria `Tree` plus a `<pre>` preview of hydrated knowledge `.md` files. That explorer needed search, flatten, git status, diffs, edit, and mutations. Growing it in-house would duplicate a path-first file tree and a syntax-highlighted editor.

`@pierre/trees` and `@pierre/diffs` (Apache-2.0) already provide that chrome. Compose Files (`/$org/ws/$slug`, no thread) stay a **workspace-repository** explorer at the projection SHA via codesearch. Conversation Files persist on the **chat sandbox** (`ctxpipe/chat/<conversationId>/1`) and reach GitHub only through brokered Commit+Push / Create PR — not `POST …/files/jobs` / `ui_file_edit`. Graph stays on hydrate knowledge.

React Aria remains the house primitive for product chrome. Pierre paints the tree and file surfaces in Shadow DOM — the same class of exception as Cosmograph.

## Decision

Use **`@pierre/trees`** (`FileTree`, search, flatten, git badges, DND, rename) and **`@pierre/diffs`** (`File`, `FileDiff`, `EditProvider`) as Files pane chrome only.

- Compose / prepare-fallback browse: `GET /{workspaceSlug}/files/tree`, `GET /{workspaceSlug}/files/blob?path=`, and `GET /{workspaceSlug}/files/status`. SHA is `activeProjectionSha`, then `desiredSha`. That surface is **not writable**.
- Conversation Files (sandbox ready): `GET|PUT /conversations/{id}/files/…`, `GET …/files/diff`, `POST …/push`. Save / autosave / ⌘S and tree mutations write the sandbox FS. Commit+Push leftover-commits then force-with-lease the session branch. Create PR is that push plus `pulls.create`. `POST /{workspaceSlug}/files/jobs` (`ui_file_edit`) is unused by the conversation pane.
- Protected default is not read-only: chat may still edit the session branch. Cannot-publish (non-GitHub / no App / no Contents write) is Read-only: no pane edits, no agent writes.
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
- Commit via GitHub Contents API from the UI: rejected for jobs (default-branch persist stays `ui_file_edit`). Conversation publish is brokered git push of the session branch, not Contents squash.
