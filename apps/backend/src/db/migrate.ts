// TODO: move this to a Railway pre-deploy job so migrations only run once per
// deploy rather than on every container startup. For now this is safe because
// drizzle migrate() is idempotent — it tracks applied migrations and skips
// ones already run.
import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import { Pool } from "pg"
import { initEvlog, log } from "../observability/logger.js"
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

if (appRolePassword) {
  await provisionAppRole(pool, appRolePassword)
}

await pool.end()
log.info({ step: "migrate", message: "[migrate] done" })
