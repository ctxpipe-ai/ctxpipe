## ADR 0001 - UI src folder structure

- **Status**: Accepted
- **Date**: 2026-02-25

### Context

Route files were accumulating page-specific components, types, and helpers. As the app scales, this would make routes hard to maintain and blur the line between shared and feature-owned code.

### Decision

Use a **feature-based** layout under `apps/ui/src`:

- **`routes/`** — Route definition and page component only; no inline subcomponents. Compose from `features/` and `components/`.
- **`features/<feature>/`** — Everything used by a single route/domain: `components/`, optional `hooks/`, `types.ts`, optional `utils.ts`. One folder per feature (e.g. `repositories`). Re-export public API via `index.ts`.
- **`components/ui/`** — Design system primitives (unchanged).
- **`components/`** — Layout and app-wide composites (e.g. AppShell, SideNav).
- **`lib/`** — API client, auth, and cross-feature utils (e.g. `formatDate` in `lib/format.ts`).

**Rule**: Used by one feature → `features/<feature>/`. Used by two or more (or app bootstrap) → `lib/` or `components/`. When something in a feature is needed elsewhere, move it to shared and update imports.

### Consequences

- Route files stay thin and easy to scan.
- Clear ownership: feature vs shared.
- New pages get a new feature folder; structure scales.

### Alternatives Considered

- Keeping all components in route files — rejected for scalability and reuse.
- Single flat `components/` with no features — rejected; harder to see what belongs to which page.

### Notes

- Path alias `@/` already maps to `src/`, so `@/features/repositories` resolves correctly.
- See root [AGENTS.md](../../AGENTS.md) for repo-wide rules; this ADR is the source of truth for UI folder structure.
