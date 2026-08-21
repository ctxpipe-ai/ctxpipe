import { BackendPostgres } from "openworkflow/postgres"
import { initEvlog, log } from "../observability/logger.js"

/** Apply OpenWorkflow schema as the table owner. Runtime connects with migrations off. */
export async function migrateOpenWorkflow(
  connectionString: string,
): Promise<void> {
  log.info({
    step: "migrate",
    message: "[migrate] running OpenWorkflow schema migrations",
  })
  const backend = await BackendPostgres.connect(connectionString, {
    runMigrations: true,
  })
  await backend.stop()
}

const invokedDirectly = process.argv[1]?.includes("migrate-openworkflow")

if (invokedDirectly) {
  initEvlog()
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error("DATABASE_URL is required")
  }
  await migrateOpenWorkflow(connectionString)
}
