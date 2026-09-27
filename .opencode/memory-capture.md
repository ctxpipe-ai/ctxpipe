<!-- BEGIN ctxpipe-memory-capture -->
## Local memory (ctxpipe)

Durable facts live in Markdown under `.ai/memory/` (see `index.md`). Candidates go to
gitignored `.ai/memory/events/`; promote with capture skills — never auto-write ADRs
from capture alone.

On hosts without lifecycle hooks, after a meaningful edit or before ending a turn, pipe a
JSON payload that includes `cwd` **and** fact-bearing text (`prompt`,
`last_assistant_message`, and/or `edits`). `cwd` alone writes nothing:

```bash
printf '%s' '{"cwd":".","prompt":"We decided the billing service runs on port 4000"}' \
  | npx -y ctxpipe memory capture observe --host opencode --event PostToolUse
printf '%s' '{"cwd":".","last_assistant_message":"Prefer ADRs in .ai/memory/decisions/ as the canonical source of truth."}' \
  | npx -y ctxpipe memory capture finalize --host opencode --event Stop
```

When candidates surface, write durable Markdown, update the matching `index.md`, then:

```bash
npx -y ctxpipe memory capture promote <candidateId>
# or: npx -y ctxpipe memory capture dismiss <candidateId>
npx -y ctxpipe memory capture summary
```
<!-- END ctxpipe-memory-capture -->
