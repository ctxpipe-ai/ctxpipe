---
name: memory-insights
description: "Track recurring session friction and success patterns across memory (sessions/, patterns). Use periodically or when improving agent instructions—not every turn."
---

# Memory Insights

Aggregate **signals** from existing memory artifacts to suggest improvements to `AGENTS.md`, app `AGENTS.md`, or `.ai/memory/patterns.md`.

## When to use

- User asks to improve agent reliability or onboarding
- Several `sessions/` files exist and you want themes
- After multiple related incidents (same confusion repeated)

## Process

1. Skim **recent** `.ai/memory/sessions/*.md` (newest first; cap at ~5 files to limit context).
2. Skim **patterns.md** “Contents” and any `@category: learning` / `bugfix` lines (use `memory-search` / `rg` if large).
3. Identify:
   - **Repeated friction** (same class of mistake or missing doc)
   - **Repeated wins** (what agents should keep doing)
4. Output **concrete** recommendations:
   - One bullet = one proposed change (which file, what sentence or pattern to add)
5. Apply only with user approval—or run **memory-sync** to append approved bullets to `patterns.md`.

## Anti-patterns

- Do not duplicate full session logs into patterns (keep patterns **short**).
- Do not invent project facts; only generalize from **existing** session/pattern text.

## See also

- [memory-reflect](../memory-reflect/SKILL.md) — single-session retro
- [.ai/memory/README.md](../../../.ai/memory/README.md)
