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

## Partial answer

Human, 2026-08-13 (layout round; 02 still open on Q12 / confidence):

- **Q1 location:** `knowledge/` for units. Leave `notion/`, `linear/`, `confluence/` as they are. Do not scatter units at the repo root.
- **Q2 files/links:** one markdown file per unit. Relative markdown links are relations (layer 1 `LINKS_TO`). Optional `claims:` front matter is layer 2 (predicate, confidence, temporality). A maintenance job may **write** layer 2 from prose links; hydrate does not. Unresolved links skipped.
- **Q3 front matter:** `AGENTS.md` `name`; `repositories/*.md` `git` required, `branch` optional. Knowledge files: none required. **Also:** optional **temporality and confidence** on claims. Ship a **skill** at `.agents/skills` (symlinked from `.claude/skills` and other agent-specific skill dirs) so authors know the format; the skill **asks the user how confident they are**, calibrates scores (typical vs strong), and **writes `valid_to` from source semantics** when possible.
- **Q4 evidence:** pointers in the unit file (link or optional `source:`) to paths already in this backing tree, or a URL. No sidecar blobs. Attached-repo code referenced via that repo’s `repositories/*.md` plus a path/URL.
- **Q5 foreign push:** next hydrate of that SHA treats the file as truth.
- **Q6 clobber / conflict:** not “never overwrite unmarked files.” An **agent** resolves conflicts by semantics: **clarification → merge files**; **conflict → resolve using confidence and temporality**. That agent is a **write-path** job (ingest/ops), not hydrate. Hydrate projects whatever the tree contains after the write.
- **Q7 maps:** root `AGENTS.md` only. No per-folder `index.md`.

Exact YAML keys, example files, and the skill body wait on hydrate combining-rule close-out, then this ticket shows two example files.
