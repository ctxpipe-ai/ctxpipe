# CTX-555: remove the folder-map marker comments; an LLM keeps the AGENTS.md folder list current

Status: done on `feat/ctx-555-folder-map-llm` (not pushed).

## Change

- Deleted `folder-map.ts` (`maintainFolderMap`, `folderMapMarkerState`), `opsFolderMapRemainder`, and `opsFolderMapFiles`. No code writes or depends on `ctxpipe:folder-map` comments now. One function, `removeFolderMapMarkers`, reads them only to remove them.
- New `folder-list.ts`:
  - `listedFolders` / `folderSetChanged`: folders to depth two from file paths. Files and hidden folders do not count.
  - `nativeFolderSetChanged`: the same check on two immutable trees in one pack.
  - `updateFolderList`: the deployment model (`getModel("medium")`, structured output) gets `AGENTS.md` and the folder list. It returns "no change" or the full file. `folderListEditIsSafe` accepts only one changed block of list lines, plus one heading for a new section, and never a front matter change. Otherwise the reply is rejected and logged. With no model (`modelProviderConfigured()` false), the step logs and skips.
  - `folderListFiles`: removes old marker lines, applies a requested rename, then runs the model step when asked.
- Hydrate (`plan-remaining-writes`): plans `ops_folder_map` with `previousSha` when the folder set changed since the active projection. It also plans one cleanup job when `AGENTS.md` still has marker lines.
- New workflow `workspace-write-ops-folder-list` (job kind stays `ops_folder_map`, so stored jobs and the rename path still work). The old name `workspace-write-ops-folder-map` is retired: it only marks its write job completed. Delete it one release after this ships.
- Bootstrap writes a plain `## Folder Structure` list with no markers, and removes old markers from an existing file.
- Chat agent prompt: one sentence says the folder structure is the map and the agent updates the `AGENTS.md` folder list when it changes folders.

## Tests

- New: `folder-list.test.ts` (folder-set diff, edit check, cleanup), `folder-list.contract.test.ts` (msw model: other heading, edit outside the list rejected, list added, no change, no model).
- Contract (real Postgres and Git): `write-ops-native` (cleanup on a real Git fixture, safe and unsafe model replies, the retired workflow, rename), `write-maintenance-native` (admission with `previousSha`, convergence), `hydrate-planner-native` (plans only on a folder-set change), `workspace-unborn-bootstrap-native`, `workflow-discovery`.

## Risks

- A run of the old workflow that was in flight at deploy completes with no commit and marks its write job completed. The next hydrate plans the new job when the folder set or markers need it.
- The model step costs one model call per folder-set change. A reply that fails the edit check is dropped, so a list can stay out of date until the next change.
