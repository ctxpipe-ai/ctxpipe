---
name: capture-adr
description: Write or update an ADR under .ai/memory/decisions and refresh decisions/index.md
---

# Capture ADR

Use when an architectural or tooling decision should be durable.

1. Pick the next `ADR-NNN` number from `.ai/memory/decisions/`.
2. Write `ADR-NNN-title-slug.md` (Status, Date, Tags, Context, Decision, Consequences).
3. **Update** `.ai/memory/decisions/index.md`.
4. If needed, link from `.ai/memory/index.md` or product context.
5. Do not invent decisions from noisy hook candidates — confirm with the user or clear session evidence.
6. After **Human decision needed** from `ctx_advisor`, the user chooses. If they hand the choice to its owner (or no one can answer), write the ADR with `Status: Proposed`: your recommendation, the options, and the trade-offs; only the owner changes it to Accepted, and until then ctx| does not treat it as settled. If the user decides it themselves and it is lasting, write it with `Status: Accepted` and note who decided.

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


