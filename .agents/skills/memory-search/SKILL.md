---
name: memory-search
description: "Search .ai/memory for keywords, topics, or ADR numbers before loading large files. Use when you need relevant memory without reading patterns.md or all ADRs whole."
---

# Memory Search

Targeted retrieval across [`.ai/memory/`](../../../.ai/memory/README.md) to support **gradual discovery** (small context budget).

## When to use

- Unsure which ADR or pattern applies
- Looking for a convention, term, or past decision by keyword
- Before reading full `patterns.md` — search may return one section to open

## How to search

1. Prefer **repository search** (`grep` / ripgrep) scoped to `.ai/memory/`:
   - `rg -i "keyword" .ai/memory --glob '*.md'`
2. Narrow scope when possible:
   - ADRs only: `.ai/memory/decisions/`
   - Conventions: `.ai/memory/patterns.md` (also try `@topic:` — e.g. `rg "@topic: backend" .ai/memory/patterns.md`)
   - Terms: `.ai/memory/glossary.md`
3. **Categories** (in patterns): `rg '@category: convention' .ai/memory/patterns.md`

## After results

- Open **one** full file or **one** ADR, not every hit
- If the hit is a line in `patterns.md`, read **that `##` section** only (see [Contents](../../../.ai/memory/patterns.md))

## See also

- [.ai/memory/README.md](../../../.ai/memory/README.md) — default read order
