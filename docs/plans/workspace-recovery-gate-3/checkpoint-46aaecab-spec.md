# Gate 3 six-kind Spec review

Reviewed pinned `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...46aaecab94c53fef0460b6e359bcadec3483b427`. This is an intermediate six-kind review, not Gate 3 acceptance.

## Findings

1. **[P1] Workspace rename discards the requested name before creating the durable command.** The lock says root `AGENTS.md` carries the display name and hydrate copies it to the Workspace; ops may update only `name` and its marked section (`02-hydration-contract.md:42-45`). `PATCH` detects `body.displayName` but passes neither it nor any name to `updateWorkspace`/`renameWorkspaceLifecycle` (`routes/v1/workspaces.ts:392-410`). The latter enqueues only `{kind:"ops_folder_map"}` (`workspace-lifecycle.ts:95-107`), and `maintainFolderMap` preserves an existing name (`folder-map.ts:29-36`). Production therefore returns/commits the old name and hydration cannot apply the requested rename. Put the requested name in the immutable ops command, update that YAML node, and prove API → commit → hydrate.

2. **[P1] Folder-map discovery can claim and delete unrelated customer instructions.** The spec requires finding the folder section “by meaning,” never a fixed string, and says “Do not rewrite unrelated customer instructions” (`03-knowledge-file-layout.md:34-37`). `maintainFolderMap` selects any heading containing `folder`, `directory`, `layout`, or `structure`, without requiring a folder map (`folder-map.ts:56-83`), then deletes bullet lines whose folder-shaped links are absent (`:89-112`). For example, under `## Directory traversal`, `- Never write [temporary output](tmp/)` is deleted when `tmp/` is absent. Require semantic folder-list evidence before owning a section; otherwise append the dedicated heading.

3. **[P2] Broken or duplicate ownership markers falsely converge.** The locked shape is one semantic folder section (`03-knowledge-file-layout.md:37`). `opsFolderMapRemainder` returns zero for any start-marker substring (`hydrate-write-jobs.ts:41-44`), while the transform returns the original for an unmatched marker (`folder-map.ts:43-55`) and edits only the first of duplicate pairs. The workflow then completes as a no-op, leaving zero or multiple managed sections. Validate exactly one ordered pair; repair safely or fail instead of recording completion, and test lone/duplicate markers.

The three prior claims findings are corrected by normalized target comparison, YAML-node mutation, predicate-less `LINKS_TO` projection, and a native post-write graph proof. No new defect was found in the unchanged command/broker/replay/hydrate boundary.
