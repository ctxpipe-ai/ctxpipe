import { fileURLToPath } from "node:url"
import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import { Pool } from "pg"
import { parseEnv } from "../config/env.js"
import { log } from "../observability/logger.js"
import { backfillGithubAppSecretsFromEnv } from "../scripts/backfillGithubConnectionSecrets.js"
import { backfillKnowledgePathState } from "./backfill-knowledge-path-state.js"
import { backfillNullOrgIds } from "./backfill-null-org-ids.js"
import { backfillMissingPagerdutyConnectionDirectory } from "./backfill-pagerduty-connection-directory.js"
import { backfillRepositoryIngestionRequests } from "./backfill-repository-ingestion-requests.js"
import { closeDb, initDb } from "./client.js"
import { migrateOpenWorkflow } from "./migrate-openworkflow.js"
import { APP_ROLE_NAME, provisionAppRole } from "./provision-app-role.js"

/**
 * The one migrate sequence for hosted, Compose, CDK and local dev. Run it as the
 * table owner. Steps: app role, Drizzle, OpenWorkflow, every backfill, grants.
 * Each step is idempotent, so a second run changes nothing.
 */
export async function runMigrations(options: {
  connectionString: string
  appRolePassword: string | undefined
  env: Record<string, string | undefined>
  roleName?: string
  /** How long one statement may wait for a lock. Default 30 000 ms. */
  lockTimeoutMs?: number
}): Promise<void> {
  const roleName = options.roleName ?? APP_ROLE_NAME
  const lockTimeoutMs = options.lockTimeoutMs ?? 30_000
  const pool = new Pool({ connectionString: options.connectionString })
  // A SET query, not a startup option: a pooled connection string can refuse
  // startup options. Only a lock wait is bounded. A statement timeout would
  // also stop the long backfills.
  pool.on("connect", (client) => {
    client
      .query(`SET lock_timeout = ${Math.trunc(lockTimeoutMs)}`)
      .catch(() => {
        // The next query on this client shows a broken connection.
      })
  })
  try {
    // First, so that a missing role stops migrate before the schema changes.
    await provisionAppRole(pool, options.appRolePassword, roleName)

    log.info({ step: "migrate", message: "[migrate] running migrations…" })
    await migrate(drizzle({ client: pool }), {
      migrationsFolder: fileURLToPath(
        new URL("../../migrations", import.meta.url),
      ),
    })
    await migrateOpenWorkflow(options.connectionString)

    await backfillNullOrgIds(pool)
    await backfillKnowledgePathState(pool)
    await backfillRepositoryIngestionRequests(pool)
    let env: ReturnType<typeof parseEnv> | undefined
    try {
      env = parseEnv(options.env)
    } catch (error) {
      log.info({
        step: "migrate",
        message: "github secrets backfill skipped (env not parseable)",
        error: error instanceof Error ? error.message : String(error),
      })
    }
    try {
      initDb(options.connectionString)
      await backfillMissingPagerdutyConnectionDirectory()
      if (env) await backfillGithubAppSecretsFromEnv(env)
    } finally {
      await closeDb()
    }

    // Again after the migrations, for the tables and schemas they added.
    await provisionAppRole(pool, undefined, roleName)
  } catch (error) {
    const code =
      (error as { code?: string }).code ??
      (error as { cause?: { code?: string } }).cause?.code
    if (code === "55P03")
      throw new Error(
        `[migrate] A statement waited more than ${lockTimeoutMs} ms for a database lock. Another session holds the lock. End that session, then run migrate again.`,
        { cause: error },
      )
    throw error
  } finally {
    await pool.end()
  }
}
