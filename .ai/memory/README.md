# Project memory (`.ai/memory`)

Canonical durable knowledge for coding agents in this repo. Navigate via
[`index.md`](./index.md). Candidate observations from host hooks land in
gitignored [`events/`](./events/) and are promoted by agents using capture skills.

## Default read order

1. This README (routing only).
2. [`index.md`](./index.md) — top-level map of durable stores.
3. [`lessons-learned.md`](./lessons-learned.md) — highest-priority confirmed rules.
4. [`decisions/index.md`](./decisions/index.md) — ADR index (not every ADR).
5. [`product-context.md`](./product-context.md) — overview/architecture as needed.
6. Open **one** ADR or glossary entry when the task touches that area.

## Write rules

| Change | Where |
|--------|--------|
| Confirmed convention / correction | `lessons-learned.md` (+ root `index.md` if store role changes) |
| Architecture decision | `decisions/ADR-NNN-*.md` + `decisions/index.md` |
| Term | `glossary.md` |
| Product/PRD fact | `PRDs/` + `PRDs/index.md` or `product-context.md` |
| Session wrap-up | `sessions/YYYY-MM-DD-*.md` + `sessions/index.md` |

Hooks never write durable ADRs. Promote from `events/` via capture skills.
See [ADR-024](decisions/ADR-024-markdown-only-local-memory-capture.md).
