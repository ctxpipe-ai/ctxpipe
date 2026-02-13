## Architecture Decision Records (ADR)

This directory contains **cross-cutting** Architecture Decision Records for the `ctxpipe` monorepo. ADRs that apply to a single app or package live in that app’s or package’s own `adr/` folder.

ADRs are short documents that capture context, decisions, and consequences for important architectural choices. They are written to be easily consumed by both humans and agents.

### Where ADRs live

- **Root `adr/`** (this directory): Monorepo-wide decisions (tooling, workspace layout, cross-app patterns). Use the template in `adr/template.md`.
- **Per app**: `apps/<app>/adr/` — e.g. `apps/backend/adr/` for backend-specific stack and design decisions.
- **Per package**: `packages/<package>/adr/` — for package-specific design and API decisions.

When changing or adding an app or package, read and add ADRs in the relevant place (root vs. that app’s or package’s `adr/`).

### Conventions

- Files are named with a zero-padded sequence number and a short slug, e.g.:
  - `0001-monorepo-structure-and-tooling.md`
  - `0002-domain-modeling-strategy.md`
- Each ADR should follow the template in `template.md` (root `adr/template.md`).
- ADRs should be immutable once accepted; create a new ADR to supersede an old one.
- Numbering is scoped per directory (each `adr/` has its own 0001, 0002, …).

### When to add an ADR

Create a new ADR when you:

- Introduce or change a major tool, framework, or runtime (root or in the app/package that owns it).
- Add or significantly change an app or package in the monorepo (in that app’s or package’s `adr/`, or root if cross-cutting).
- Make a decision that will guide how future agents should design or extend the system.

Agents should prefer reading ADRs (and keeping them updated) before making structural or architectural changes to the project.

