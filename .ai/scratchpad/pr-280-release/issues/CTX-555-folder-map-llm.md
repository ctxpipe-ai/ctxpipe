# CTX-555: remove the folder-map marker comments; an LLM keeps the AGENTS.md folder list current

Status: done on `feat/ctx-555-folder-map-llm` (not pushed).

## Change

- Deleted `folder-map.ts` (`maintainFolderMap`, `folderMapMarkerState`), `opsFolderMapRemainder`, and `opsFolderMapFiles`. No code writes or depends on `ctxpipe:folder-map` comments now. One function, `removeFolderMapMarkers`, reads them only to remove them.
- New `folder-list.ts`:
  - `listedFolders` / `folderSetChanged`: folders to depth two from file paths. Files and hidden folders do not count. Below a connector-mirror root, only the root counts.
  - `nativeFolderSetChanged`: the same check on two immutable trees in one pack.
  - `updateFolderList`: the deployment model (`getModel("medium")`, a strict tool call) gets the `AGENTS.md` body as numbered blocks (front matter, fenced code, and HTML comments are left out) and returns only `{ listBlock: <index> | "none" }`. The model writes no text into the file. `applyFolderListChoice` uses the block only when each line is a list item that names exactly one folder of the previous or current tree and links to nothing else. It keeps the lines of current folders as they are, drops the lines of gone folders, and adds a "- `folder/`" line for each new top-level folder. Otherwise it appends a short `## Folders` section. With no model, or more than 200 folders, the step logs and skips.
  - `folderListFiles`: removes old marker lines, applies a requested rename, then runs the model step when asked.
- Hydrate (`plan-remaining-writes`): plans `ops_folder_map` with `previousSha` when the folder set changed since the active projection. It also plans one cleanup job when `AGENTS.md` still has marker lines.
- New workflow `workspace-write-ops-folder-list` (job kind stays `ops_folder_map`, so stored jobs and the rename path still work). The old name `workspace-write-ops-folder-map` is retired: it only marks its write job completed. Delete it one release after this ships.
- Bootstrap writes a plain `## Folder Structure` list with no markers. Only the folder-list job removes old markers.
- Chat agent prompt: one sentence says the folder structure is the map and the agent updates the `AGENTS.md` folder list when it changes folders.

## Tests

- New: `folder-list.test.ts` (folder-set diff, mirror roots, blocks without fences and comments, the reviewer probes, unusual heading, cleanup), `folder-list.contract.test.ts` (msw model: other heading, edit outside the list rejected, list added, no change, no model).
- Contract (real Postgres and Git): `write-ops-native` (cleanup on a real Git fixture, a model choice and a reply that carries text, the retired workflow, rename), `write-maintenance-native` (admission with `previousSha`, convergence), `hydrate-planner-native` (plans only on a folder-set change), `workspace-unborn-bootstrap-native`, `workflow-discovery`.

- Reservation: a new folder change on the same planning root gets a new job (the job id and the dedupe key include `previousSha`).

## Risks

- A run of the old workflow that was in flight at deploy completes with no commit and marks its write job completed. The next hydrate plans the new job when the folder set or markers need it.
- The model step costs one model call per folder-set change. When the model picks no usable block, a `## Folders` section is appended, which can duplicate a list the model did not find.
