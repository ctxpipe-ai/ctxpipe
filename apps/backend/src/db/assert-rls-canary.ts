import { Pool, type PoolClient } from "pg"
import { log } from "../observability/logger.js"

/** Stable sentinel row; `workspaces.org_id` is not an FK. */
export const RLS_CANARY_ORG_ID = "org_rls_boot_canary"
export const RLS_CANARY_WORKSPACE_ID = "ws_rls_boot_canary"
export const RLS_CANARY_SLUG = "rls-canary"
export const RLS_CANARY_DISPLAY_NAME = "RLS canary"
export const RLS_CANARY_REPOSITORY_URL =
  "https://github.com/ctxpipe-ai/rls-canary"

/** Namespaced advisory lock so backend + worker boots serialize the canary. */
export const RLS_CANARY_LOCK_K1 = 872314
export const RLS_CANARY_LOCK_K2 = 28

export function assertSeededCanaryVisible(
  rowCount: number,
  operation: "SELECT" | "UPDATE",
): void {
  if (rowCount !== 1) {
    throw new Error(
      `RLS canary: expected ${operation} 1 workspace row under GUC, got ${rowCount}`,
    )
  }
}

export function assertSeededCanaryHidden(
  rowCount: number,
  operation: "SELECT" | "UPDATE",
): void {
  if (rowCount !== 0) {
    throw new Error(
      `RLS canary: expected ${operation} 0 without GUC, got ${rowCount} (ENABLE not binding or role has BYPASSRLS)`,
    )
  }
}

async function withTransaction<T>(
  client: PoolClient,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query("BEGIN")
  try {
    const result = await fn()
    await client.query("COMMIT")
    return result
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  }
}

/**
 * Seed one workspace under `SET LOCAL app.organization_id`, then prove the
 * same row is invisible and un-updatable without the GUC. Empty-table
 * `count(*)=0` is not a canary.
 */
export async function assertSeededRlsCanary(
  connectionString = process.env.DATABASE_URL,
): Promise<void> {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required")
  }
  const pool = new Pool({ connectionString, max: 1 })
  const client = await pool.connect()
  try {
    await client.query("SELECT pg_advisory_lock($1, $2)", [
      RLS_CANARY_LOCK_K1,
      RLS_CANARY_LOCK_K2,
    ])
    try {
      await withTransaction(client, async () => {
        await client.query(
          "SELECT set_config('app.organization_id', $1, true)",
          [RLS_CANARY_ORG_ID],
        )
        await client.query("DELETE FROM workspaces WHERE id = $1", [
          RLS_CANARY_WORKSPACE_ID,
        ])
        await client.query(
          `INSERT INTO workspaces (
             id, org_id, slug, display_name, workspace_repository_url
           ) VALUES ($1, $2, $3, $4, $5)`,
          [
            RLS_CANARY_WORKSPACE_ID,
            RLS_CANARY_ORG_ID,
            RLS_CANARY_SLUG,
            RLS_CANARY_DISPLAY_NAME,
            RLS_CANARY_REPOSITORY_URL,
          ],
        )
        const selected = await client.query<{ id: string }>(
          "SELECT id FROM workspaces WHERE id = $1",
          [RLS_CANARY_WORKSPACE_ID],
        )
        assertSeededCanaryVisible(selected.rowCount ?? 0, "SELECT")
        const updated = await client.query(
          "UPDATE workspaces SET display_name = $2, updated_at = now() WHERE id = $1",
          [RLS_CANARY_WORKSPACE_ID, `${RLS_CANARY_DISPLAY_NAME} ok`],
        )
        assertSeededCanaryVisible(updated.rowCount ?? 0, "UPDATE")
      })

      await withTransaction(client, async () => {
        const guc = await client.query<{ v: string | null }>(
          "SELECT current_setting('app.organization_id', true) AS v",
        )
        if (guc.rows[0]?.v) {
          throw new Error(
            `RLS canary: app.organization_id leaked after COMMIT (${guc.rows[0].v}); set_config must be local`,
          )
        }
        const selected = await client.query<{ id: string }>(
          "SELECT id FROM workspaces WHERE id = $1",
          [RLS_CANARY_WORKSPACE_ID],
        )
        assertSeededCanaryHidden(selected.rowCount ?? 0, "SELECT")
        const updated = await client.query(
          "UPDATE workspaces SET display_name = $2 WHERE id = $1",
          [RLS_CANARY_WORKSPACE_ID, "rls-canary-should-not-apply"],
        )
        assertSeededCanaryHidden(updated.rowCount ?? 0, "UPDATE")
      })
    } finally {
      await client.query("SELECT pg_advisory_unlock($1, $2)", [
        RLS_CANARY_LOCK_K1,
        RLS_CANARY_LOCK_K2,
      ])
    }
    log.info({
      step: "boot.rls-canary",
      message: "Seeded RLS canary: visible under GUC, hidden without GUC",
      workspaceId: RLS_CANARY_WORKSPACE_ID,
    })
  } finally {
    client.release()
    await pool.end()
  }
}
