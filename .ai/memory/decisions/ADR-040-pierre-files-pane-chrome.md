# ADR-040: Pierre trees and diffs as Workspace Files chrome

**Status:** Accepted (revised 2026-10-11) | **Date:** 2026-08-19 | **Tags:** ui, workspaces, git

## Context

The Workspace Files pane needs a path-first tree with search, git status, diffs and editing. Growing a React Aria tree and a `<pre>` preview in-house would duplicate what `@pierre/trees` and `@pierre/diffs` (Apache-2.0) already provide.

## Decision

- Files pane chrome is **`@pierre/trees`** (`FileTree`, search, git badges, rename) and **`@pierre/diffs`** (`File`, `FileDiff`, `EditProvider`). React Aria stays the primitive for the rest of the product; Pierre renders in Shadow DOM, the same exception as Cosmograph. Theme it through host CSS variables, not utility classes on rows. Context menus stay React Aria.
- **Compose Files** (`/$org/ws/$slug`, no conversation) browse the workspace repository at the active projection SHA and are read-only.
- **Conversation Files** read and write the conversation's sandbox worktree through `…/conversations/{id}/files/…` routes with per-file version checks. Work reaches GitHub on the conversation session branch (`ctxpipe/chat/<conversation>/<n>`), pushed by the backend broker (the agent's push tool or **Commit+Push**), and is published with **Create PR** / **Show PR** ([ADR-048](ADR-048-native-postgres-sandbox-ownership.md)).
- A read-only Workspace (no Contents:write, non-GitHub host) allows no pane edits.
- **Diff pane** (revision 2026-10-11, PR 280 ticket 34): the Diff tab lists the conversation's changed files against the base branch with `@pierre/diffs` `FileDiff` rows. A card at the end of each turn lists the files that turn changed. At the start and at the end of a turn, the backend writes the sandbox work tree as a git tree object (a copy of the index, so the real index does not change) and keeps it under `refs/ctxpipe/turns/<run>/`. The changed-file list of each turn goes in the existing `chat_metadata` table (namespace `ctxpipe.conversation-turn-changes`). No new table or column is necessary. The backend gives each file one status (added, modified, deleted, renamed), its line counts and its bodies from one `git diff` with renames on. Binary files, files over 1 MB and symlinks get no body. The UI shows what the backend gives. A card goes after the last message of its run. Only the newest 50 turns keep their snapshot refs, and a turn diff whose snapshots are gone answers 410.

## Consequences

- Tree accessibility is Pierre's; keyboard and focus are proven in Storybook plays, not assumed from React Aria.
- `useFileTree` is create-once: later tree and status updates go through `resetPaths` / `setGitStatus`.
- The conversation chrome has Commit+Push, Create PR and Show PR. The agent commits and pushes when a task is done or when asked (semantic commits through the backend broker); Create PR keeps the commits. Automatic per-turn push and squash-on-PR were tried and dropped (user, 2026-10-04; PR 280 ticket 02).

## Alternatives considered

- Keep growing the React Aria tree: rejected; the feature set exists in Pierre.
- A knowledge-only explorer of hydrated `.md` units: rejected; the pane is the repository.
- GitHub Contents API commits from the UI: rejected; default-branch writes are jobs ([ADR-047](ADR-047-native-durable-write-workflows.md)).
