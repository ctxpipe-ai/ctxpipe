## Architecture Decision Records (ADR)

This directory contains Architecture Decision Records for the `ctxpipe` monorepo.

ADRs are short documents that capture context, decisions, and consequences for
important architectural choices. They are written to be easily consumed by both
humans and agents.

### Conventions

- Files are named with a zero-padded sequence number and a short slug, e.g.:
  - `0001-monorepo-structure-and-tooling.md`
  - `0002-domain-modeling-strategy.md`
- Each ADR should follow the template in `template.md`.
- ADRs should be immutable once accepted; create a new ADR to supersede an old one.

### When to add an ADR

Create a new ADR when you:

- Introduce or change a major tool, framework, or runtime.
- Add or significantly change an app or package in the monorepo.
- Make a decision that will guide how future agents should design or extend the system.

Agents should prefer reading ADRs (and keeping them updated) before making
structural or architectural changes to the project.

