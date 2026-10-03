# Knowledge Markdown and front-matter layout

Type: grilling
Status: resolved
Blocked by: 02

## Question

What is the **on-disk layout** of git-backed knowledge in the project repository?

The brief: mostly markdown with front matter, including claims. Connector mirrors already own `notion/`, `linear/`, and Confluence managed trees. Extracted objects/claims have no git representation today.

**Locked by [Git-canonical knowledge and deterministic hydrate](02-hydration-contract.md) — do not re-grill:** files; path identity; layer 1 links + layer 2 optional `claims:`; hydrate never infers from prose; write-path jobs may write layer 2; skip malformed; foreign push is truth.

## Answer

Human lock, 2026-08-14. Smallest reviewable tree; agents understand it from `AGENTS.md` + the knowledge skill, no extra tools. Hydrate does not care how deep `knowledge/` is.

**Tree**

```text
AGENTS.md
knowledge/…                    # any depth; greenfield default: knowledge/<area>/<unit>.md
repositories/<name>.md
linear/   notion/   confluence/ # existing connector mirrors + config.yaml
.agents/skills/ctxpipe-knowledge/SKILL.md
.claude/skills -> ../.agents/skills   # and other agent skill dirs, same target
```

- **`knowledge/`:** area-first. **Greenfield** (empty tree): prefer `knowledge/<area>/<unit>.md` (kebab-case area slug). **Existing tree:** generators **adapt** to whatever structure is already there (any number of levels). Hydrate treats the full path as identity and does not interpret folders. Kind/source are optional front matter, not required folders.
- **`repositories/`** stays flat (few remotes).
- Connector trees unchanged. Secrets stay in `connections`; `linear/config.yaml`, `notion/config.yaml`, `confluence/config.yaml` stay git-canonical.

**`AGENTS.md`**

- Front matter `name:` (Workspace display name). All other keys optional.
- **One** semantic folder-structure section (user may name it and choose heading level). No custom HTML tags. The ops agent **finds it by meaning** (the list of folders + what is in them), never by a fixed string, and **maintains that one section** — never a second copy. Keep user folders that exist on disk; remove dead links; keep extra user-described folders that exist. If none exists, insert a **Folder Structure** heading once. Do not rewrite unrelated customer instructions.

**Schema (v1). As many fields as possible optional.**

- Knowledge files: **zero required keys**. Body markdown is enough. Unknown keys ignored.
- `claims[]`: all fields optional. `to` is **relative to the declaring file** (same as markdown links). `to` missing ⇒ skip that item (body links still make layer 1 `LINKS_TO`). `predicate` missing ⇒ layer 1 only for that target. `confidence` / `valid_from` / `valid_to` / `source` / `generated_by` optional. `valid_to` omitted or `null` = evergreen. `generated_by: ctxpipe` is a hint for merge, **not** an ownership gate.
- `repositories/*.md`: **`git` required**, checkoutable URL (`https://github.com/acme/billing.git`). `branch` and body optional.

**Skill:** `.agents/skills/ctxpipe-knowledge/SKILL.md`. Covers layout, schema, confidence calibration (0.5 typical, 0.7 strong, ≥0.85 rare), ask the user how sure they are, set `valid_to` from source when possible, **match the existing `knowledge/` tree** (or start `knowledge/<area>/<unit>.md` if empty) — plus **what a good item looks like**: one unit per file; short; links to other units instead of pasting them; claims only for facts you would defend; no meeting-dump blobs; no serving-store jargon (`obj_`, SPO tables) in the file.

**Examples** (greenfield shape; `to` file-relative)

`knowledge/payments/api.md`:

```markdown
---
claims:
  - to: ../billing/ledger.md
    predicate: DEPENDS_ON
    confidence: 0.7
    source: ../../linear/issues/PAY-12.md
---

The payments API depends on [Billing ledger](../billing/ledger.md).
```

`repositories/billing.md`:

```markdown
---
git: https://github.com/acme/billing.git
branch: main
---

Billing service and ledger.
```

Ingest/maintenance write this layout; hydrate only reads it. Conflict merge and folder-map updates are write-path agents ([Ingest-to-git write and concurrency protocol](10-ingest-to-git-write-protocol.md)).

## Comments

- 2026-08-14 — Q13 area-first. Sol asked exact H2 + strict two-level; human rejected both (Q15 semantic section; Q16 any depth, greenfield prefers two-level).
- 2026-08-14 — Q14 `to` file-relative. Resolved.
