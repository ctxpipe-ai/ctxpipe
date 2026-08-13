# Knowledge Markdown and front-matter layout

Type: grilling
Status: open
Blocked by: 02

## Question

What is the **on-disk layout** of git-backed knowledge in the project repository?

The brief: mostly markdown with front matter, including claims. Connector mirrors already own `notion/`, `linear/`, and Confluence managed trees. Extracted objects/claims have no git representation today.

**Inheriting from [Git-canonical knowledge and deterministic hydrate](02-hydration-contract.md) (do not re-grill once 02 locks them):** knowledge is **files**, not an export of `obj_` / `claim_` rows. **Path is identity** (or serving ids are derived from path) so foreign agents can create files without our ID generator. **Links/paths in files are relations.** A **root folder map** describes directories (not every file) so agents understand the tree with no extra skill; adding a connector updates that map. Project **display name** lives in that root file’s front matter.

Settle:

- Root map **filename** (`AGENTS.md` vs `agents.md` vs `index.md`) and collision with Cursor/Codex `AGENTS.md` when the backing repo is an existing product repo.
- Root directory and how it avoids colliding with connector trees and the customer's own docs.
- One file per entity vs grouped files; how a markdown link becomes a serving claim.
- Front-matter schema: display name on the root map; what else (kind, status) vs body text only.
- Evidence: same file, sidecar, or pointers at source paths already in git?
- Human-editable: a person or foreign agent edits a file and pushes — next hydrate treats it as truth?
- Generated vs hand-written: a marker so ingest does not clobber human edits?
- Config that today lives in `connections.config` vs config files in git (already true for `notion/config.yaml` / `linear/config.yaml`).
- Per-folder `index.md` in addition to the root map, or root map only?

Recommend the smallest layout that hydrates without an LLM and stays reviewable in a GitHub diff. Show two example files, not a 20-type taxonomy. This layout **blocks** migration and ingest — they cannot export or commit without it.
