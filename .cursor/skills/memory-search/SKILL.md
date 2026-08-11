---
name: memory-search
description: "Find facts in .ai/memory via index.md routers and rg (excludes events/). Use when recalling a convention, decision, glossary term, or PRD detail without loading the whole tree."
---

# Memory search (Markdown recall)

No embeddings daemon. Durable knowledge is Markdown under `.ai/memory/`.

## Procedure

1. **Indexes first** — open `.ai/memory/index.md`, then the matching store index (`decisions/index.md`, `PRDs/index.md`, `sessions/index.md`) if the category is known.
2. **Targeted `rg`** — when the category is unknown or indexes are thin:

```bash
rg -i "keyword" .ai/memory --glob '*.md' --glob '!events/**'
```

Narrow when possible:

- Decisions: `rg -i "keyword" .ai/memory/decisions --glob '*.md'`
- Lessons: `rg -i "keyword" .ai/memory/lessons-learned.md`
- Glossary: `rg -i "keyword" .ai/memory/glossary.md`
- PRDs: `rg -i "keyword" .ai/memory/PRDs --glob '*.md'`

3. **Open one hit** — read the matching section or single ADR, not every match.
4. **Skip `events/`** — candidate inbox is gitignored runtime noise; do not treat it as durable recall.

## Do not

- Spawn AgentMemory / hosted embedding search
- Load the entire `.ai/memory/` tree into context
- Search `events/` for “source of truth” facts
