# Project memory (`.ai/memory`)

Persistent, **token-level** context for AI agents working on this repo. Storage on disk does **not** use the LLM context window until you **read** files into the prompt—use **staged retrieval** to avoid bloat.

## What lives where

| Path | Role | CoALA-style | Git |
|------|------|-------------|-----|
| [README.md](./README.md) (this file) | Router: where to read/write first | — | tracked |
| [product-context.md](./product-context.md) | Product/architecture overview | Semantic (facts) | tracked |
| [glossary.md](./glossary.md) | Terms and definitions | Semantic | tracked |
| [patterns.md](./patterns.md) | Conventions and lessons learned | Procedural + distilled episodic | tracked |
| [decisions/](./decisions/) | ADRs — major architectural choices | Semantic (stable decisions) | tracked |
| [sessions/](./sessions/) | Short episodic summaries per session | Episodic | tracked |
| `active-context.md` | Current focus, blockers (working set) | Working | **gitignored** |
| `progress.md` | Task checklists | Working | **gitignored** |

## Default read order (gradual discovery)

**Goal:** small first load; drill down only when needed.

1. This **README** (routing only).
2. [decisions/README.md](./decisions/README.md) — ADR **index**, not every ADR.
3. [product-context.md](./product-context.md) — skim **Project overview** / **Architecture**; full file only if the task is broad.
4. [patterns.md](./patterns.md) — read **Contents** TOC, then **only** the section matching your area (`@topic`: monorepo, architecture, backend, auth, ui, testing). Use **memory-search** if unsure.
5. Open **one** ADR by name/number when touching that decision area.

**Do not** load all ADRs or the full `patterns.md` into context unless the task truly requires it.

## Write rules

| Change | Where | Tier (see `memory-sync` skill) |
|--------|--------|----------------------------------|
| Major tool/stack/app decision | New file in `decisions/` | Review (ADR) |
| Repeatable “how we do X” | Append under correct section in `patterns.md` + `@category` + `@topic` | Auto |
| Term definition | `glossary.md` | Auto (append) |
| Current task / checklist | `active-context.md`, `progress.md` | Auto |
| Session wrap-up | `sessions/YYYY-MM-DD-topic.md` | Auto (via session-handoff) |
| Product-level facts | `product-context.md` | Review if substantive |

## Skills

- **memory-init** — first-time layout
- **memory-sync** — proactive updates (auto + review tiers)
- **memory-search** — keyword / topic grep across memory
- **memory-reflect** — lightweight retrospective
- **memory-insights** — suggest friction/success notes for patterns or sessions
- **session-handoff** — handoff prompt + optional `sessions/` file

## References

- [Memory in the Age of AI Agents (survey)](https://arxiv.org/pdf/2512.13564) — forms, functions, dynamics
- [CoALA — Cognitive Architectures for Language Agents](https://arxiv.org/pdf/2309.02427) — working vs long-term memory, internal actions
- [ConKeeper / context-keeper](https://github.com/swannysec/context-keeper)
