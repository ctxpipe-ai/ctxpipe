# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **[`.ai/memory/README.md`](../memory/README.md)** — router and default read order
- **[`.ai/memory/index.md`](../memory/index.md)** — map of durable stores
- **[`.ai/memory/lessons-learned.md`](../memory/lessons-learned.md)** — confirmed conventions
- **[`.ai/memory/product-context.md`](../memory/product-context.md)** — product/architecture overview (skim relevant sections)
- **[`.ai/memory/glossary.md`](../memory/glossary.md)** — domain vocabulary
- **[`.ai/memory/decisions/index.md`](../memory/decisions/index.md)** — ADR index; then open one ADR as needed

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. Domain sharpening happens via `/domain-modeling` and capture skills when terms or decisions get resolved — write into `.ai/memory/`, not a new root `CONTEXT.md` or `docs/adr/`.

## File structure

Single-context (this repo):

```
/
├── .ai/
│   ├── agents/                 ← skill config (this file)
│   ├── scratchpad/             ← local issue tracker
│   └── memory/
│       ├── README.md
│       ├── index.md
│       ├── lessons-learned.md
│       ├── product-context.md
│       ├── glossary.md
│       ├── PRDs/
│       ├── decisions/          ← ADRs + index.md
│       ├── sessions/
│       └── events/             ← gitignored candidates
└── apps/ …
```

Do **not** create a top-level `docs/` tree for agent domain docs — `apps/docs` is the public documentation site.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `.ai/memory/glossary.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling` / `capture-glossary`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
