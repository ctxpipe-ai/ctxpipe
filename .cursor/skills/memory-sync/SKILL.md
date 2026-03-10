---
name: memory-sync
description: |
  Persist important session state to the ConKeeper memory bank. 
  
  TRIGGER CONDITIONS — Use this skill when:
  - A significant technical decision is made (architecture, tooling, patterns)
  - User corrects the agent or provides feedback on mistakes
  - User expresses preferences (code style, UX, workflow)
  - New project context is revealed (personas, SLAs, compliance, standards)
  - Workarounds or discoveries are made that future sessions should know about
  - The agent learns something that isn't obvious from reading the code
  
  This skill updates active-context.md, progress.md, and creates ADRs in decisions/.
---

# Memory Sync

Synchronize current session state to the ConKeeper memory bank. This skill ensures that important context, decisions, and learnings persist across sessions.

## When to Use This Skill

Use `memory-sync` proactively whenever the conversation produces knowledge that future sessions should retain. Do not wait for the user to ask — trigger this skill automatically when any of the following occur:

### 1. Significant Technical Decisions
When architectural or tooling choices are made that affect how the codebase evolves:
- Technology selections (e.g., "Replacing REST with GraphQL", "Switching to Kafka for events")
- Configuration changes (e.g., "Enabling TypeScript strict mode", "Adopting ESLint rule X")
- Architecture patterns (e.g., "Using CQRS for write operations", "Introducing micro-frontends")
- Infrastructure decisions (e.g., "Moving to Kubernetes", "Adding Redis cache layer")

### 2. User Corrections and Feedback
When the user points out mistakes or clarifies requirements:
- "Actually, we use tabs not spaces"
- "That's wrong — the API returns 204 on success, not 200"
- "We don't support IE11, you can ignore that"
- "The function name should be `parseUserData`, not `parseUser`"

### 3. User Preferences
When the user expresses how they want things done:
- Code style preferences (naming conventions, formatting, organization)
- UX/UI preferences (animation styles, component patterns)
- Workflow preferences (test coverage requirements, PR size limits)
- Communication preferences (verbosity level, code comment style)

### 4. New Project Context
When the user reveals information not discoverable from code:
- Target personas and user needs (e.g., "Our users are mostly on mobile", "This is for enterprise admins")
- SLA/SLO requirements (e.g., "P99 must be under 100ms", "99.99% uptime required")
- Compliance and standards (e.g., "Must be WCAG 2.1 AA compliant", "SOC2 Type II required")
- Business constraints (e.g., "Must work offline", "No cloud dependencies")
- Domain knowledge (e.g., "In healthcare, 'patient' means X not Y")

### 5. Workarounds and Discoveries
When the agent learns something through exploration or debugging:
- "The library has a bug in v2.3, use this workaround"
- "The dev server only works with Node 18, not 20"
- "Need to run `docker-compose` with `--build` flag after schema changes"

### 6. Pattern Establishment
When recurring conventions emerge:
- "Always validate inputs at the API boundary"
- "Use this specific error handling pattern for async operations"
- "Component naming: `[Feature][Type]` (e.g., `UserCard`, `UserList`)"

## Sync Process

### Step 1: Review Current State

Read current memory files:
- active-context.md
- progress.md
- Recent entries in decisions/

### Step 2: Analyze Session

**Privacy:** When analyzing memory files, skip any content within `<private>...</private>` blocks.
Do not reference, move, or modify private content. Do not include private content in sync summaries.
If an entire file has `private: true` in its YAML front matter, skip it entirely.

Review conversation for:
- Decisions made (architectural, implementation, tooling)
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
