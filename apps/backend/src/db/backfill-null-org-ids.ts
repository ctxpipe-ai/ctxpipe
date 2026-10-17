import type { Pool } from "pg"

/**
 * Copy "org_id" from the parent row to each row that has no "org_id". RLS hides
 * these rows from the app role. A rollback to the previous image can write them,
 * and the migration backfill does not run again. Run this as the owner on each
 * migrate. It is idempotent. The next major release sets NOT NULL and removes it.
 */
export async function backfillNullOrgIds(pool: Pool): Promise<void> {
  await pool.query(
    `UPDATE "claim_evidence" AS e SET "org_id" = c."org_id" FROM "claims" AS c WHERE e."claim_id" = c."id" AND e."org_id" IS NULL`,
  )
  await pool.query(
    `UPDATE "confluence_spaces" AS s SET "org_id" = c."org_id" FROM "connections" AS c WHERE s."connection_id" = c."id" AND s."org_id" IS NULL`,
  )
  await pool.query(
    `UPDATE "repository_checkouts" AS ch SET "org_id" = r."org_id" FROM "repositories" AS r WHERE ch."repository_id" = r."id" AND ch."org_id" IS NULL`,
  )
}
