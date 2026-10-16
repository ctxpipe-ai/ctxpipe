// Owner-role migrate jobs that run `drizzle-kit migrate` (scripts/db-migrate.sh,
// the hosted deploy workflow) call this after the migrations.
import { config } from "dotenv"
import { Pool } from "pg"
import { backfillNullOrgIds } from "./backfill-null-org-ids.js"

config({ path: ".env.local", quiet: true })
config({ path: ".env", quiet: true })

const url = process.env.DATABASE_URL
if (!url) throw new Error("DATABASE_URL is required")
const pool = new Pool({ connectionString: url })
try {
  await backfillNullOrgIds(pool)
} finally {
  await pool.end()
}
