---
name: memory-reflect
description: "Lightweight session retrospective: summarize what worked, what confused the agent, and propose a sessions/ note or pattern bullet. Use after substantial tasks or before handoff."
---

# Memory Reflect

Short **retrospective** to improve future sessions—does not replace **memory-sync** for persisting decisions.

## When to use

- After a long or error-prone task
- User asks for a quick retro
- Before **session-handoff** (optional prelude)

## Process

1. Review the conversation (and any edits made): successes, false assumptions, repeated corrections.
2. Produce **3–6 bullets**:
   - **Worked well** — tools, files, or approaches that helped
   - **Friction** — ambiguity, missing docs, misleading names
   - **Proposed follow-up** — optional ADR, pattern line, or doc fix (if actionable)
3. If valuable for continuity, suggest appending to:
   - `.ai/memory/sessions/YYYY-MM-DD-topic.md` (compact narrative), and/or
   - `.ai/memory/patterns.md` (single durable lesson with `@category: learning` and matching `@topic:`)

## Output format

```markdown
## Memory reflect

### Worked
- …

### Friction
- …

### Suggested persistence
- [ ] sessions/… OR patterns.md bullet: …
```

Run **memory-sync** (or **session-handoff**) if you add files or append patterns.

## See also

- [.ai/memory/README.md](../../../.ai/memory/README.md)
- [session-handoff](../session-handoff/SKILL.md)
