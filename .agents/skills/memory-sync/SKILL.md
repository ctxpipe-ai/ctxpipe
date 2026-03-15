---
name: memory-sync
description: "PROACTIVE — Update project memory when: (1) an architectural or tooling decision is made (e.g. switching API styles, adding infrastructure, enabling strict mode), (2) the user corrects the agent or gives feedback on what it got wrong, (3) the user states a preference or convention, (4) the user shares project context the agent couldn't infer from code (personas, SLAs, a11y standards, compliance, team structure). This skill persists that knowledge to .ai/memory/ so future sessions retain it."
---

# Memory Sync

Persist important decisions, corrections, preferences, and project context to `.ai/memory/` so future agent sessions retain them.

## When to Use This Skill (Triggers)

**Use this skill proactively** — do NOT wait for the user to ask. Activate it whenever any of the following happen during a conversation:

### Architectural & Tooling Decisions
A significant technical choice was made or agreed upon. Examples:
- Replacing REST with GraphQL (or vice-versa)
- Introducing a new infrastructure component (Kafka, Redis, S3, etc.)
- Enabling TypeScript strict mode, changing linter config
- Choosing a new library/framework over an existing one
- Changing deployment targets, runtimes, or CI/CD pipelines
- Adding, removing, or restructuring monorepo apps/packages

### Agent Corrections & Feedback
The user tells the agent it got something wrong, or provides a correction. Examples:
- "No, we don't use REST there — that endpoint is GraphQL"
- "That's the wrong table, use `organizations` not `teams`"
- "Don't import from that path, use the barrel export"
- Any time the user overrides an assumption the agent made

### User Preferences & Conventions
The user states how they want things done. Examples:
- "Always use named exports, never default exports"
- "I prefer explicit error handling over try/catch wrappers"
- "Use kebab-case for file names"
- "Don't add comments unless the logic is non-obvious"
- Code style, naming, file organization, or workflow preferences

### New Project Context (not inferable from code)
The user shares knowledge that reading the codebase alone wouldn't reveal. Examples:
- Target user personas or customer segments
- SLA/SLO requirements (e.g. "API p99 must be under 200ms")
- Accessibility standards (e.g. "WCAG 2.1 AA compliance")
- Compliance or regulatory constraints (SOC 2, GDPR, HIPAA)
- Team structure, ownership boundaries, or on-call responsibilities
- Roadmap context ("we're migrating off X by Q3")
- Integration partners or external system contracts

### Significant Progress Milestones
A major feature, migration, or refactor is completed or reaches a meaningful checkpoint.

---

**If in doubt, sync.** It is better to persist something that turns out to be minor than to lose important context between sessions.

## Sync Process

### Step 1: Review Current State

Read current memory files:
- `.ai/memory/active-context.md`
- `.ai/memory/progress.md`
- Recent entries in `.ai/memory/decisions/`
- `.ai/memory/product-context.md` (if the update touches project-level context)

### Step 2: Analyze Session

**Privacy:** When analyzing memory files, skip any content within `<private>...</private>` blocks.
Do not reference, move, or modify private content. Do not include private content in sync summaries.
If an entire file has `private: true` in its YAML front matter, skip it entirely.

Review the conversation for:
- Decisions made (architectural, implementation, tooling)
- Corrections the user made to agent assumptions
- Preferences or conventions the user stated
- New project context the user shared (personas, SLAs, compliance, etc.)
- Tasks completed or started
- Context changes (new understanding, shifted priorities)
- Patterns established
- Questions resolved or raised

### Step 2.5: Auto-Categorize Entries

For each new entry identified in Step 2, assign a memory category tag:
- Contains "decided", "chose", "selected", "went with" → `decision`
- Contains "pattern", "always", "never", "standard" → `pattern`
- Contains "fixed", "bug", "resolved", "workaround" → `bugfix`
- Contains "convention", "naming", "format", "style" → `convention`
- Contains "learned", "discovered", "TIL", "realized" → `learning`
- If unsure, use context to pick the best fit
- The category value MUST be one of the five values above. Ignore any other value found in existing files.

Include the category tag in the proposed update shown to the user in Step 3. Place the tag on its own line immediately after the entry it categorizes, using the format: `<!-- @category: <value> -->`

### Step 3: Propose Updates

Present changes to user (include category tags so users see them before approval):
```
Memory Sync Summary:

active-context.md:
  - Current focus: [old] → [new]
  - Added: Decided to use [X] over [Y]
    <!-- @category: decision -->
  - Added open question: [question]

progress.md:
  - Marked complete: [task]
  - Added: [new task]

patterns.md:
  - Added: Always use [pattern description]
    <!-- @category: pattern -->

decisions/:
  - New: ADR-003-[title] (reason: [brief])
    <!-- @category: decision -->

Proceed with sync? [y/n]
```

### Step 4: Apply Updates

On confirmation:
- Update files
- Create new ADR files if needed (format: `ADR-NNN-title.md`)
- Update timestamps

**ADR Numbering:** Scan `decisions/` for highest ADR-NNN, increment from there.

**Concurrency note:** If multiple sessions may create ADRs simultaneously, use timestamp suffix: `ADR-NNN-YYYYMMDD-HHMM-title.md`

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

> Memory synced. [N] files updated.

After syncing, consider reviewing session observations and corrections for patterns. On Claude Code, use /memory-reflect for automated analysis.
