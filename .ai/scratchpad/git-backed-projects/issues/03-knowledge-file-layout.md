# Knowledge Markdown and front-matter layout

Type: grilling
Status: claimed
Blocked by: 02

## Question

What is the **on-disk layout** of git-backed knowledge in the project repository?

The brief: mostly markdown with front matter, including claims. Connector mirrors already own `notion/`, `linear/`, and Confluence managed trees. Extracted objects/claims have no git representation today.

**Locked by [Git-canonical knowledge and deterministic hydrate](02-hydration-contract.md) — do not re-grill:**

- Knowledge is **files**; **path is identity**; layer 1 = relative markdown links (`LINKS_TO`); layer 2 = optional `claims:` (predicate, confidence, `valid_from` / `valid_to`). Hydrate never infers from prose. Maintenance job may write layer 2.
- Root **`AGENTS.md`**: `name` + marked folder-map section (ops agent edits those only). `knowledge/` for units. `repositories/*.md` for attached remotes (`git` required, `branch` optional, body optional). Connector trees stay `notion/`, `linear/`, `confluence/`. Root `AGENTS.md` only (no per-folder `index.md`).
- Foreign push is truth. Write-path agent merges clarifications / resolves conflicts via confidence and temporality. Skill at `.agents/skills` (symlinked from `.claude/skills` and other agent skill dirs): format + ask confidence + write `valid_to` when the source has one.
- Evidence: pointers in the unit file, no sidecars.

Settle (layout only, still open):

- Exact YAML keys and two example files (this ticket must show them).
- How the **marked** `AGENTS.md` folder-map section is delimited so the ops agent cannot eat customer instructions.
- Connector `config.yaml` vs secrets still in `connections` (already true today — confirm keep).
- Whether `generated_by: ctxpipe` (or similar) still exists now that Q6 is semantic merge, not “never overwrite unmarked files.”
- Skill filename and what it must contain (short).

Recommend the smallest layout that hydrates without an LLM and stays reviewable in a GitHub diff. Show two example files, not a 20-type taxonomy.

## Partial answer

Human, 2026-08-13 (layout round; hydrate now resolved):

- **Q1 location:** `knowledge/` for units. Leave `notion/`, `linear/`, `confluence/` as they are.
- **Q2 files/links:** one markdown file per unit. Layer 1 / layer 2 as locked on 02.
- **Q3 front matter:** `AGENTS.md` `name`; `repositories/*.md` `git` / optional `branch`. Knowledge files: none required besides optional `claims:`. Skill calibrates confidence and writes `valid_to`.
- **Q4 evidence:** pointers in the unit file.
- **Q5 foreign push:** hydrate treats the SHA as truth.
- **Q6 clobber:** write-path agent, semantic merge / confidence+temporality resolve.
- **Q7 maps:** root `AGENTS.md` only.
