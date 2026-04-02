---
name: memory-sync
description: "PROACTIVE — Update project memory when: (1) architectural/tooling decisions, (2) user corrections, (3) preferences/conventions, (4) non-inferrable project context. Uses auto-apply for low-risk writes; ADR creation/edits require user confirmation unless user opted into full auto."
---

# Memory Sync

Persist important decisions, corrections, preferences, and project context to `.ai/memory/` so future agent sessions retain them.

See [.ai/memory/README.md](../../../.ai/memory/README.md) for file roles, default read order, and context-budget guidance.

## When to Use This Skill (Triggers)

**Use this skill proactively** — do NOT wait for the user to ask. Activate whenever any of the following happen during a conversation:

### Architectural & Tooling Decisions
A significant technical choice was made or agreed upon (new infra, frameworks, monorepo structure, strict mode, CI/CD, etc.).

### Agent Corrections & Feedback
The user overrides an assumption the agent made.

### User Preferences & Conventions
Naming, style, workflow, or code organization preferences.

### New Project Context (not inferable from code)
Personas, SLAs, a11y/compliance, team structure, roadmap, external contracts.

### Significant Progress Milestones
Feature complete, migration checkpoint, major refactor done.

---

**If in doubt, sync.** Prefer auto-tier writes over losing context.

## Two tiers (auto-apply vs review)

### Tier A — Auto-apply (no user confirmation)

Apply these updates **immediately** after completing Steps 1–2.5. Do not block on "Proceed? [y/n]".

- **`progress.md`**: checklist updates, completed items, new backlog lines.
- **`active-context.md`**: current focus, open questions, blockers (create file if missing).
- **`patterns.md`**: **append-only** new bullets under the correct `##` section; include `<!-- @category: … -->` and `<!-- @topic: … -->` matching that section’s topic (see [.ai/memory/patterns.md](../../../.ai/memory/patterns.md) TOC).
- **`glossary.md`**: append-only term definitions.

Tier A is safe because it is additive or local-only (gitignored working files), and patterns/glossary remain auditable in git history.

### Tier B — Review required (user confirmation)

Stop and show a summary; apply **only after** explicit user approval (or after user says e.g. “memory: apply all”, “yes to ADR”, etc.):

- **New or materially edited ADRs** under `.ai/memory/decisions/` (any change beyond typo/link fix).
- **`product-context.md`**: new sections or substantive rewrites (not link fixes or single-line clarifications).
- **Destructive edits**: removing or rewriting existing bullets in `patterns.md` / `glossary.md` (prefer strikethrough + replacement note in Tier B summary instead of silent delete).

If a session mixes Tier A and Tier B: **apply Tier A first**, then present Tier B summary and wait for confirmation before writing ADRs or large product-context edits.

### User override

If the user says **memory: auto** (or similar), you may apply Tier B in the same turn without a separate confirmation step—still list what you changed in the final confirmation message.

## Sync Process

### Step 1: Review Current State

Read:
- `.ai/memory/README.md` (if unsure where to write)
- `.ai/memory/active-context.md` (if present)
- `.ai/memory/progress.md` (if present)
- Relevant `.ai/memory/decisions/` files (if architectural)
- `.ai/memory/product-context.md` (if project-level)

### Step 2: Analyze Session

**Privacy:** Skip `<private>...</private>` blocks and files with `private: true` front matter.

Extract: decisions, corrections, preferences, new context, tasks done/open, patterns, resolved questions.

### Step 2.5: Auto-Categorize Entries

For each new entry, assign **one** category (for tags):

- `decision` — decided / chose / selected
- `pattern` — repeatable technical approach
- `bugfix` — fixed / workaround / resolved defect
- `convention` — naming / format / style
- `learning` — discovered / TIL

Tag format after the bullet: `<!-- @category: <value> -->`

### Step 3: Classify tiers and execute

1. List which updates are Tier A vs Tier B.
2. **Apply all Tier A** writes immediately.
3. For Tier B, output the summary block below and **wait** for user confirmation (unless `memory: auto`).

Optional summary format for Tier B:

```
Memory Sync — review required (Tier B):

decisions/:
  - New: ADR-NNN-[title] (brief)
    <!-- @category: decision -->

product-context.md:
  - [what would change]

Proceed with Tier B? [y/n]   (or say "memory: auto")
```

### Step 4: Apply Tier B (after approval)

- Create/update ADR files: `ADR-NNN-title-slug.md`
- Update `product-context.md` as agreed

**ADR Numbering:** Highest `ADR-NNN` in `decisions/`, increment. For concurrent risk: `ADR-NNN-YYYYMMDD-HHMM-title.md`.

**ADR Format:**

```markdown
# ADR-NNN: [Title]

**Status:** Accepted | **Date:** [date] | **Tags:** [tags]

## Context
[Why this decision was needed - 1-2 sentences]

## Decision
[What was decided - 1 sentence]

## Rationale
- [Key reason 1]
- [Key reason 2]

## Consequences
- [Positive consequence]
- [Tradeoff accepted]

## Alternatives Considered
- [Alt 1]: [Why rejected]
```

### Step 5: Confirm

> Memory synced. Tier A: [files]. Tier B: [files or "none"].

After syncing, optionally run **memory-reflect** for a short session retrospective.
