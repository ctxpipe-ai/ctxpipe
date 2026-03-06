---
name: session-handoff
description: Generate a complete handoff prompt for seamless continuation in a new session. Use when context is filling up or before ending a productive session.
---

# Session Handoff

Generate a complete handoff package for seamless session continuation.

## When to Use

- Context window approaching limit
- Before ending a productive session
- User requests handoff explicitly
- Complex task spans multiple sessions

## Handoff Process

### Step 0: Check Token Budget

Read `.claude/memory/.memory-config.md` for token budget (if exists):
- `economy`: Session summary ~200-400 tokens (brief, 2-3 sentences)
- `light`: Session summary ~400-700 tokens (concise, 3-5 sentences)
- `standard`: Session summary ~600-1000 tokens (default, 5-8 sentences)
- `detailed`: Session summary ~900-1500 tokens (comprehensive, 8-12 sentences)

If no config exists, use `standard` budget.

### Step 1: Sync Memory First

Before generating handoff:
- Update active-context.md with current state
- Add any new decisions to decisions/
- Update progress.md
- Create session summary in sessions/

**Session file format:** `sessions/YYYY-MM-DD-topic.md`

> **Note:** Include timestamp (HHMM) to avoid overwriting previous same-day sessions. Use topic suffix when a clear topic exists.

```markdown
# Session: [date]

## Summary
Brief summary of what was accomplished.
- economy: 2-3 sentences
- light: 3-5 sentences
- standard: 5-8 sentences (default)
- detailed: 8-12 sentences with comprehensive context

## Work Completed
- [Item 1]
- [Item 2]

## Decisions Made
- ADR-NNN: [title] (if applicable)

## Context for Next Session
- [Key context point]

## Open Questions
- [Question if any]

---
*Session duration: ~[time]*
```

### Step 2: Gather Handoff Context

Collect:
- **Original goal:** What the user asked for
- **Current task:** What we're actively working on
- **Progress:** What's been completed
- **Remaining work:** What still needs doing
- **Key decisions:** Decisions made (reference ADRs)
- **Blockers/questions:** Unresolved issues
- **Critical files:** Files being modified
- **Recent errors:** Any errors being debugged

### Step 3: Generate Handoff Prompt

Output a copyable prompt:

~~~markdown
## Handoff Prompt (copy everything below)

```
I'm continuing work on [project-name] from a previous session.

## Original Goal
[What the user originally asked for]

## Session Summary
[2-3 sentence summary]

## Current State
- **Active task:** [Current work]
- **Files in progress:** [List files]
- **Last action:** [Recent action]

## Completed This Session
- [Item 1]
- [Item 2]

## Remaining Work
- [ ] [Task 1 - next priority]
- [ ] [Task 2]

## Key Decisions Made
- [Decision 1] (see ADR-NNN)

## Open Questions/Blockers
- [Question or blocker]

## Context to Load
Project memory is at: .claude/memory/
Key files to review: [list files]

Please load the project memory and continue with [next task].
```
~~~

### Step 4: Confirm

> Session handoff complete. Memory synced.
>
> Copy the prompt above into a new session to continue.
