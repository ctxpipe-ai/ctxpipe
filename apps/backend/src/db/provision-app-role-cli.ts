import { Pool } from "pg"
import { log } from "../observability/logger.js"
import { APP_ROLE_NAME, provisionAppRole } from "./provision-app-role.js"

const connectionString = process.env.DATABASE_URL
const appRolePassword = process.env.DATABASE_APP_PASSWORD
if (!connectionString) {
  throw new Error("DATABASE_URL is required to provision ctxpipe_app")
}
if (!appRolePassword) {
  throw new Error(
    "DATABASE_APP_PASSWORD is required to provision ctxpipe_app (no default; refusing to guess)",
  )
}

const pool = new Pool({ connectionString })
await provisionAppRole(pool, appRolePassword)
await pool.end()
log.info({
  step: "migrate",
  message: "[migrate] app role grants complete",
  role: APP_ROLE_NAME,
})
