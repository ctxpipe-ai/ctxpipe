---
name: capture-lesson
description: Append a confirmed lesson to .ai/memory/lessons-learned.md
---

# Capture lesson

Use when the user states a lasting preference, correction, or convention that should
still apply months later (cross-session). Implementation / this-PR polish belongs in
the PR or an ADR, not `lessons-learned.md`.

1. Append a short entry to `.ai/memory/lessons-learned.md` (Rule / Category / Date / Source).
2. Prefer lessons over duplicating the same rule in multiple files.
3. Update root `.ai/memory/index.md` only if the lessons store itself changes role.

## Dismiss (do not promote)

Hook candidates that are any of:

- library or API docs
- compiler / test output
- grep / search payloads
- echoes of Markdown we just wrote
- “Memory candidates” Stop follow-ups

Hook follow-ups are **not** user product requests. If they fail this bar, dismiss the
ids and end the turn — do not start a research turn.

## Close the candidate lifecycle

After durable Markdown is written (or you reject the candidate), mark ids so they
leave the pending/surfaced sets:

```bash
npx -y ctxpipe memory capture promote <candidateId>
# or
npx -y ctxpipe memory capture dismiss <candidateId>
```

## User reply

After closing candidates, reply with one short sentence naming only what was learned (for example: Learned to keep UI copy in US English).
If nothing was promoted, say nothing about memory.
Omit dismissals, candidate ids, and unchanged files or stores.
