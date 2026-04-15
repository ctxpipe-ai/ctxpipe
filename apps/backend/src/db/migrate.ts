// TODO: move this to a Railway pre-deploy job so migrations only run once per
// deploy rather than on every container startup. For now this is safe because
// drizzle migrate() is idempotent — it tracks applied migrations and skips
// ones already run.
import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import { Pool } from "pg"
import { initEvlog, log } from "../observability/logger.js"

initEvlog()

const connectionString = process.env.DATABASE_URL ?? "[REDACTED]"

const pool = new Pool({ connectionString })
const db = drizzle({ client: pool })

log.info({ step: "migrate", message: "[migrate] running migrations…" })
await migrate(db, { migrationsFolder: "./apps/backend/migrations" })
await pool.end()
log.info({ step: "migrate", message: "[migrate] done" })
