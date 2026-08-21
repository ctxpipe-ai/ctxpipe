// TODO: move this to a Railway pre-deploy job so migrations only run once per
// deploy rather than on every container startup. For now this is safe because
// drizzle migrate() is idempotent — it tracks applied migrations and skips
// ones already run.
import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import { Pool } from "pg"
import { parseEnv } from "../config/env.js"
import { initEvlog, log } from "../observability/logger.js"
import { backfillGithubAppSecretsFromEnv } from "../scripts/backfillGithubConnectionSecrets.js"
import { closeDb, initDb } from "./client.js"
import { migrateLanggraphCheckpoints } from "./migrate-checkpoints.js"
import { migrateOpenWorkflow } from "./migrate-openworkflow.js"
import { APP_ROLE_NAME, provisionAppRole } from "./provision-app-role.js"

initEvlog()

const connectionString = process.env.DATABASE_URL ?? "[REDACTED]"
const appRolePassword = process.env.DATABASE_APP_PASSWORD

const pool = new Pool({ connectionString })
const db = drizzle({ client: pool })

if (appRolePassword) {
  log.info({
    step: "migrate",
    message: "[migrate] provisioning app role before migrations",
    role: APP_ROLE_NAME,
  })
  await provisionAppRole(pool, appRolePassword)
}

log.info({ step: "migrate", message: "[migrate] running migrations…" })
await migrate(db, { migrationsFolder: "./apps/backend/migrations" })
await migrateOpenWorkflow(connectionString)
await migrateLanggraphCheckpoints(connectionString)

let env: ReturnType<typeof parseEnv> | undefined
try {
  env = parseEnv(process.env as Record<string, string | undefined>)
} catch (error) {
  log.info({
    step: "migrate",
    message: "github secrets backfill skipped (env not parseable)",
    error: error instanceof Error ? error.message : String(error),
  })
}
if (env) {
  try {
    initDb(connectionString)
    await backfillGithubAppSecretsFromEnv(env)
  } finally {
    await closeDb()
  }
}

if (appRolePassword) {
  await provisionAppRole(pool, appRolePassword)
}

await pool.end()
log.info({ step: "migrate", message: "[migrate] done" })
