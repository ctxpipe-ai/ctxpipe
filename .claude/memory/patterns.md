# Project Patterns

## Code Conventions
- **Biome** for linting and formatting across the monorepo
- **Zod schemas collocated** with the modules they describe (routes, domain, DB models) — no central `src/schemas`
- **Avoid pulling to globals** — inline config/one-off values unless reused in more than one place
- **TypeScript strict mode** — `noUncheckedIndexedAccess`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`
- **DB migrations** only in `apps/backend`; generate via `pnpm run db:generate`, never hand-write migration SQL
- **Transactions** — always wrap multi-table operations in `db.transaction(async (tx) => { ... })`

## Architecture Patterns
- **Hono apps** for both backend and codesearch — REST via `@hono/zod-openapi`, MCP via `@hono/mcp`
- **Domain services** shared between REST routes and MCP tools
- **Public API routes** are org-scoped: `/:orgSlug/api/v1`
- **OpenAPI spec** at `/.docs/openapi` (JSON), Scalar API reference at `/.docs/api-reference`
- **IDs**: TEXT type, `<prefix>_<base32 encoded uuid>` (e.g. `repo_...`)
- **Docker Compose** as the single local dev entry point (`pnpm dev` = `docker compose up`)

## Authentication Patterns
- **Better Auth social providers** use environment-based conditional configuration — defined in `auth/config.ts` but only active when corresponding env vars (e.g., `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`) are present
  <!-- @category: pattern -->
- **Auth provider UI discovery** — `@daveyplate/better-auth-ui` automatically displays available social providers based on backend configuration; no manual UI component updates needed when adding providers
  <!-- @category: pattern -->

## Testing Patterns
- **apps/ui**: Vitest + Testing Library for component tests, Storybook for exploration
- Backend and codesearch testing patterns TBD

---
*Last updated: 2026-03-06*
