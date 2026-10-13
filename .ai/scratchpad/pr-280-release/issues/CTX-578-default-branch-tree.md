# CTX-578: show the default branch tree until the sandbox is ready

Status: done on `ui/ctx-578` (not pushed).

## Problem

In a new conversation, the sandbox is not ready for some seconds. The conversation tree route answers `409 missing_sandbox`, and no earlier list is in the cache. The Files pane showed no tree in that time.

## Change

- `ConversationSandboxFilesPane` (`apps/ui/src/features/workspaces/WorkspaceFilesPane.tsx`) uses the Workspace tree route (`workspaceGitTreeOptions`) when the sandbox tree says `ready: false` with no paths. No new backend route. The Workspace files pane uses the same route, so the same auth and file filters apply.
- In default branch mode, the pane is read-only. A file opens from the Workspace blob route, not the conversation blob route. A note says "Read-only default branch. You can edit when the sandbox is ready." The pane shows no git status and no Save button, so the user cannot type text that can get lost.
- `WorkspacePane` gives `sandboxPrepared` to the pane. When the chat session says that the sandbox is ready, the pane gets the sandbox tree again at once.
- `WorkspaceFileTree` keeps the open folders when it gets a new path list (`resetPaths` with `initialExpandedPaths`). The selected file stays when its path is in the new list.

## Proof

- Story `WorkspacePane.stories.tsx` `DefaultBranchUntilSandboxReady` (golden): default tree, open folders, open a file read-only, sandbox ready, sandbox tree with the same open folders and selected file, then Save shows and the sandbox content loads.
- Story `WorkspaceFileTree.stories.tsx` `NewPathsKeepExpandedFolders` (golden).
- `SandboxLoading` now has an empty Workspace index, so it still shows the loading state.

## Open points

- The Workspace tree is the indexed default branch. If the index is behind the remote branch, the tree can be a little old until the sandbox is ready.
