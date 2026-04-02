// TODO: move this to a Railway pre-deploy job so migrations only run once per
// deploy rather than on every container startup. For now this is safe because
// drizzle migrate() is idempotent — it tracks applied migrations and skips
// ones already run.
import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import { Pool } from "pg"

const connectionString =
  process.env.DATABASE_URL ??
  "postgresql://ctxpipe:ctxpipe@localhost:5433/ctxpipe"

  console.log("connectionString", connectionString)

const pool = new Pool({ connectionString })
const db = drizzle({ client: pool })

console.log("[migrate] running migrations…")
await migrate(db, { migrationsFolder: "./apps/backend/migrations" })
await pool.end()
console.log("[migrate] done")
