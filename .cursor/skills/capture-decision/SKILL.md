---
name: capture-decision
description: Capture a lighter decision note or route to capture-adr for full ADRs
---

# Capture decision

- If the change is a major architecture/tooling choice → use **capture-adr**.
- Otherwise note it under the matching durable file (lessons, PRD, product-context) and **update the matching index.md**.
- Never auto-write durable decisions from hook candidates without review.

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


