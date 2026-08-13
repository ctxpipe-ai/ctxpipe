# Knowledge Markdown and front-matter layout

Type: grilling
Status: open
Blocked by: 02

## Question

What is the **on-disk layout** of git-backed knowledge in the project repository?

The brief: mostly markdown with front matter, including claims. Connector mirrors already own `notion/`, `linear/`, and Confluence managed trees. Extracted objects/claims have no git representation today.

**Paused:** [Git-canonical knowledge and deterministic hydrate](02-hydration-contract.md) was reopened after Sol review. Treat the bullets below as a **draft inherit**, not a lock, until 02 is resolved.

**Draft inherit from 02 (do not re-grill until 02 locks them):**

- Knowledge is **files**; **path is identity**; **links/paths are relations**. Serving ids derive from Project + path. Foreign agents do not need `obj_`.
- Root folder map is **`AGENTS.md`** (display name in front matter). Folder-changing **ops** update it with TanStack `chat()` **without** sandbox/harness — not append, not hydrate.
- Attached remotes are **`repositories/*.md`**: front matter has git URL, branch, and similar clone fields; body describes the remote so an agent can decide whether to explore it. Backing remote is implicit (this repo) + `AGENTS.md`. Duplicate git URLs: skip extras as malformed.
- Hydrate is a read-only projection of one SHA (skip malformed; same SHA no-op). Git-detected rename rewrites references on the **write** path.

Settle (layout only):

- Where knowledge units live besides `AGENTS.md`, `repositories/`, and existing connector trees (`notion/`, `linear/`, Confluence). A dedicated prefix vs mixed with the customer’s own docs.
- One file per unit vs grouped files; how a markdown link becomes a serving edge (syntax).
- Front-matter schema: `AGENTS.md` display name; `repositories/*.md` clone fields; knowledge-unit files — what is required vs body-only.
- Evidence: same file, sidecar, or pointers at source paths already in git?
- Human-editable: a person or foreign agent edits a file and pushes — next hydrate treats it as truth?
- Generated vs hand-written: a marker so ingest does not clobber human edits?
- Config that today lives in `connections.config` vs config files in git (already true for `notion/config.yaml` / `linear/config.yaml`).
- Per-folder `index.md` in addition to `AGENTS.md`, or root map only?

Recommend the smallest layout that hydrates without an LLM and stays reviewable in a GitHub diff. Show two example files, not a 20-type taxonomy. This layout **blocks** migration and ingest — they cannot export or commit without it.
