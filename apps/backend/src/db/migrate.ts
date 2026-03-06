import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import { Pool } from "pg"

const connectionString =
  process.env.DATABASE_URL ??
  "postgresql://ctxpipe:ctxpipe@localhost:5433/ctxpipe"

const pool = new Pool({ connectionString })
const db = drizzle({ client: pool })

console.log("[migrate] running migrations…")
await migrate(db, { migrationsFolder: "./apps/backend/migrations" })
await pool.end()
console.log("[migrate] done")
