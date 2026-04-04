# Rerun skill derivation (Phase 2 only)

Recomputes **Skill** nodes and **MEMBER_OF_PRIMARY** claims from existing **InstructionUnit** rows in Postgres (no LLM, no codesearch file reads). Persists via the same path as ingestion: `deduplicateAndStore` → Falkor projection → optional embeddings.

## Prerequisites

- `apps/backend/.env.local` with `DATABASE_URL`, `AUTH_SECRET`, `GRAPH_DB_URI`, and the usual model/embedding variables (unless you pass `--skip-embed`).
- Organization UUID and repository ID (same IDs as in the DB / API).

## Command

From the repository root:

```bash
pnpm --filter @ctxpipe/backend run rerun-skill-derivation -- \
  --org-id <organization-uuid> \
  --repository-id <repository-id> \
  [--target-hash <git-sha>] \
  [--skip-embed]
```

Or from `apps/backend`:

```bash
pnpm run rerun-skill-derivation -- --org-id <uuid> --repository-id <id>
```

`--target-hash` defaults to `payload.target_hash` on instruction units, then `repositories.last_ingested_hash`.

## Programmatic use

Import `rerunSkillDerivationFromDb` from `src/scripts/rerunSkillDerivation.ts` and call with `orgId`, `orgSlug`, `repositoryId`, and optional `targetHash` / `skipEmbed`, inside a process that has already called `initDb` and (for CLI-style use) loaded env.
