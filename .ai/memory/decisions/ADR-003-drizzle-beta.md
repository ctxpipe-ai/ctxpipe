# ADR-003: Drizzle ORM beta (v1.x)

**Status:** Accepted | **Date:** 2026-02-13 | **Tags:** backend, drizzle, orm

## Context

The backend uses Drizzle ORM for PostgreSQL (see ADR-002). Drizzle is evolving toward v1.0: the current stable line (0.x) uses an older API and has known design limitations. The v1.x beta introduces new syntax, fixes outstanding design issues, and adds capabilities we expect to rely on as the backend grows.

Adopting stable 0.x now would mean a non-trivial migration later when v1 is released, and we would miss improvements and fixes that are already available in beta.

## Decision

We will use the **Drizzle ORM beta** (v1.x) for both `drizzle-orm` and `drizzle-kit` by pinning to the `beta` dist-tag in `package.json`:

- `drizzle-orm`: `"beta"`
- `drizzle-kit`: `"beta"`

New code (schema definitions, queries, migrations) should follow the v1 API and documentation. We accept that beta APIs may change before v1.0; we will track release notes and adjust if needed.

## Consequences

**Positive**

- Aligns the codebase with the direction of Drizzle v1 and avoids a large migration from 0.x to 1.x later.
- Benefits from current design fixes and new features (e.g. connection API, typing, relational query behavior).
- Enables use of v1-only features as we build out the data layer.

**Negative / trade-offs**

- Beta stability: we may need to update code or config when the beta changes before v1.0.
- Documentation and community examples still skew toward 0.x; we may need to infer from types or changelogs occasionally.

## Alternatives Considered

- **Stay on Drizzle 0.x (latest stable)**: Rejected to avoid a future migration and to gain current design and API improvements.
- **Pin to a specific beta version (e.g. `^1.0.0-beta.15`)**: Rejected in favor of the `beta` dist-tag so we can get fixes and minor beta updates without manually bumping; we can switch to a fixed range if beta churn becomes an issue.

## Notes

- When Drizzle v1.0 is released, we should switch from the `beta` tag to a normal semver range (e.g. `^1.0.0`).
- Connection setup uses the v1 API: `drizzle(connectionString, { schema })` in `src/db/client.ts` (see [Drizzle connect docs](https://orm.drizzle.team/docs/connect-overview)).
