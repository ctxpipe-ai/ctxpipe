---
name: capture-glossary
description: Add or update a term in .ai/memory/glossary.md
---

# Capture glossary term

1. Add or update the term in `.ai/memory/glossary.md`.
2. Keep definitions project-specific and concise.
3. Cross-link ADRs when a term is decision-shaped.

## Close the candidate lifecycle

After durable Markdown is written (or you reject the candidate), mark ids so they
leave the pending/surfaced sets:

```bash
npx -y ctxpipe memory capture promote <candidateId>
# or
npx -y ctxpipe memory capture dismiss <candidateId>
```

Include the `.ai/memory/` change in the commit for the work it came from.

## User reply

After closing candidates, reply with one short sentence naming only what was learned (for example: Learned to keep UI copy in US English).
If nothing was promoted, say nothing about memory.
Omit dismissals, candidate ids, and unchanged files or stores.


