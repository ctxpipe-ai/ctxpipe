---
name: capture-lesson
description: Append a confirmed lesson to .ai/memory/lessons-learned.md
---

# Capture lesson

Use when the user states a lasting preference, correction, or convention.

1. Append a short entry to `.ai/memory/lessons-learned.md` (Rule / Category / Date / Source).
2. Prefer lessons over duplicating the same rule in multiple files.
3. Update root `.ai/memory/index.md` only if the lessons store itself changes role.

## Close the candidate lifecycle

After durable Markdown is written (or you reject the candidate), mark ids so they
leave the pending/surfaced sets:

```bash
npx -y ctxpipe memory capture promote <candidateId>
# or
npx -y ctxpipe memory capture dismiss <candidateId>
```
