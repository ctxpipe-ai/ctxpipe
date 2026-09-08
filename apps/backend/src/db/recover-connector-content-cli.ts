import { parseArgs } from "node:util"
import { BackendPostgres } from "openworkflow/postgres"
import { Pool } from "pg"
import {
  backfillConnectorContentAdmissions,
  previewConnectorContentAdmissions,
} from "./backfill-connector-content-admissions.js"
import { closeDb, initDb } from "./client.js"

const { values } = parseArgs({
  options: {
    org: { type: "string" },
    connection: { type: "string", multiple: true },
    apply: { type: "boolean", default: false },
  },
})
const url = process.env.DATABASE_URL
if (!url) throw new Error("DATABASE_URL is required")
if (!values.org || !values.connection?.length)
  throw new Error(
    "Provide --org ORG_ID and one or more --connection CONNECTION_ID; preview is the default",
  )
const scope = { orgId: values.org, connectionIds: values.connection }
const pool = new Pool({ connectionString: url })
try {
  initDb(url)
  const plans = await previewConnectorContentAdmissions(pool, scope)
  process.stdout.write(
    `${JSON.stringify({ mode: values.apply ? "apply" : "preview", plans }, null, 2)}\n`,
  )
  if (values.apply) {
    const backend = await BackendPostgres.connect(url, { runMigrations: false })
    try {
      await backfillConnectorContentAdmissions(pool, backend, scope)
    } finally {
      await backend.stop()
    }
  }
} finally {
  await pool.end()
  await closeDb()
}
