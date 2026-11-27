import type { Pool } from "pg"

/**
 * Count the main-era knowledge files of each Workspace that has no count yet
 * (CTX-1715). The units of the active projection with source `legacy` are
 * the files of the legacy overlay (ADR-053), so the count is known at the
 * deploy, before the next hydrate of the Workspace. Hydrate then writes the
 * count again for each projection. Run this as the owner on each migrate. It
 * is idempotent: it changes only rows with no count.
 */
export async function backfillLegacyKnowledgeFiles(pool: Pool): Promise<void> {
  await pool.query(
    `UPDATE "workspaces" AS w SET "legacy_knowledge_files" = (
       SELECT count(*)::int FROM "workspace_knowledge_units" AS u
       WHERE u."workspace_id" = w."id" AND u."source" = 'legacy'
     )
     WHERE w."legacy_knowledge_files" IS NULL AND w."active_projection_sha" IS NOT NULL`,
  )
}
