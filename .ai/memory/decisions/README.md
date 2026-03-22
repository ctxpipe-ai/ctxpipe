# Architecture Decision Records (ADRs)

This directory is the **single source of truth** for Architecture Decision Records in the ctxpipe monorepo. There are no `adr/` directories elsewhere in the repo.

Parent guide: [`.ai/memory/README.md`](../README.md) (read order, write tiers, skills).

## Conventions

- **Naming**: `ADR-NNN-title-slug.md` (e.g. `ADR-001-frontend-ui-app-stack.md`). Numbers are global (ADR-001, ADR-002, …).
- **Format**: Status | Date | Tags; Context; Decision; Rationale/Consequences; Alternatives Considered; Notes. Cross-references use same-directory links (e.g. `[ADR-007](ADR-007-remove-cloudflare-workers-runtime.md)`).
- **New ADRs**: Use the next available number. When superseding a decision, add a new ADR and reference it from the old one; optionally mark the old one as Superseded.

## When to add an ADR

- Introduce or change a major tool, framework, or runtime.
- Add or significantly change an app or package.
- Make a decision that will guide how future agents should design or extend the system.

Agents should read ADRs here before making structural or architectural changes.
