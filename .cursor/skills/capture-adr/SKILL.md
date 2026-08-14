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

