# Knowledge Markdown and front-matter layout

Type: grilling
Status: claimed
Blocked by: 02

## Question

What is the **on-disk layout** of git-backed knowledge in the project repository?

The brief: mostly markdown with front matter, including claims. Connector mirrors already own `notion/`, `linear/`, and Confluence managed trees. Extracted objects/claims have no git representation today.

**Locked by [Git-canonical knowledge and deterministic hydrate](02-hydration-contract.md) — do not re-grill:** files; path identity; layer 1 links + layer 2 optional `claims:`; hydrate never infers from prose; maintenance job may write layer 2; skip malformed; foreign push is truth.

## Answer

Human lock, 2026-08-14. Smallest reviewable tree; agents understand it from `AGENTS.md` + the knowledge skill, no extra tools.

**Tree**

```text
AGENTS.md
knowledge/<area>/<unit>.md
repositories/<name>.md
linear/   notion/   confluence/     # existing connector mirrors + config.yaml
.agents/skills/ctxpipe-knowledge/SKILL.md
.claude/skills -> ../.agents/skills   # and other agent skill dirs, same target
```

- **`knowledge/<area>/<unit>.md`:** area-first, two levels. `<area>` is a kebab-case slug. No files directly in `knowledge/`. Deeper paths only when an area is large. Path is still identity; hydrate does not interpret area names. The ops agent may create an area and must list it under **Folder Structure**. Kind/source are optional front matter, not folders.
- **`repositories/`** stays flat (few remotes).
- Connector trees unchanged. Secrets stay in `connections`; `linear/config.yaml`, `notion/config.yaml`, `confluence/config.yaml` stay git-canonical.

**`AGENTS.md`**

- Front matter `name:` (Project display name). All other keys optional.
- Heading **Folder Structure** (no custom HTML tags). The ops agent (unsandboxed TanStack `chat()`) rewrites that section: keep user folders that **exist on disk**, remove dead links, may edit the existing list. Other sections are customer instructions — do not eat them. If the heading is missing, the agent **inserts** it once.

**Schema (v1). As many fields as possible optional.**

- Knowledge files: **zero required keys**. Body markdown is enough. Unknown keys ignored.
- `claims[]`: all fields optional. `to` missing ⇒ skip that item (body links still make layer 1 `LINKS_TO`). `predicate` missing ⇒ layer 1 only for that target. `confidence` / `valid_from` / `valid_to` / `source` / `generated_by` optional. `valid_to` omitted or `null` = evergreen. `to` is a repo-relative path. `generated_by: ctxpipe` is a hint for merge, **not** an ownership gate.
- `repositories/*.md`: **`git` required**, checkoutable URL (`https://github.com/acme/billing.git`). `branch` and body optional.

**Skill:** `.agents/skills/ctxpipe-knowledge/SKILL.md`. Covers layout, schema, confidence calibration (0.5 typical, 0.7 strong, ≥0.85 rare), ask the user how sure they are, set `valid_to` from source when possible, put units in the best existing area or add one kebab area — plus **what a good item looks like**: one unit per file; short; links to other units instead of pasting them; claims only for facts you would defend; no meeting-dump blobs; no serving-store jargon (`obj_`, SPO tables) in the file.

**Examples**

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

Ingest/maintenance write this layout; hydrate only reads it. Conflict merge and Folder Structure updates are write-path agents ([Ingest-to-git write and concurrency protocol](10-ingest-to-git-write-protocol.md)).

## Partial answer (rounds)

- Q1–Q7: `knowledge/` + connector trees; one file per unit; evidence pointers; foreign push is truth; semantic merge; root `AGENTS.md` only.
- Q8: **Folder Structure** heading; agent keeps existing folders, drops dead links.
- Q9: keep config.yaml vs secrets split.
- Q10: optional `generated_by`; do not over-index.
- Q11: skill path as above, including good-item guidance.
- Q12: checkoutable `git` URL; almost all other fields optional.
- Q13: area-first `knowledge/<area>/<unit>.md`.

## Comments

- 2026-08-14 — Q13 accepted. Draft answer ready for Sol before resolve.
