---
name: drizzle-migrations
description: Enforces correct Drizzle migration workflow. Use when adding/changing tables, columns, indexes, or any schema changes. NEVER manually create migration SQL — always run pnpm run db:generate.
---

# Drizzle Migrations

## BLOCKER: Never Manually Create Migration SQL

Do NOT write or create `migration.sql` files yourself. Drizzle Kit generates them from schema diffs. Manual SQL will:

- Break snapshot consistency
- Cause migration conflicts
- Omit metadata drizzle-kit expects

## Correct Workflow

1. Edit schema files in `apps/backend/src/db/schema/`
2. Run: `pnpm run db:generate` from `apps/backend` (or `pnpm --filter @ctxpipe/backend db:generate` from repo root)
3. Review the generated migration in `apps/backend/migrations/`
4. If generation fails, fix the schema — do not fall back to manual SQL

## Command Reference

| Action             | Command                | CWD          |
| ------------------ | ---------------------- | ------------ |
| Generate migration | `pnpm run db:generate` | apps/backend |
| Apply migrations   | `pnpm run db:migrate`  | apps/backend |
| Studio             | `pnpm run db:studio`   | apps/backend |

## Schema Locations

- Main schema index: `apps/backend/src/db/schema/index.ts`
- Table definitions: `apps/backend/src/db/schema/*.ts`
- Drizzle config: `apps/backend/drizzle.config.ts`
