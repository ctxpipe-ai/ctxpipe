import { BackendPostgres } from "openworkflow/postgres"
import { log } from "../observability/logger.js"

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

/** GitHub migrate jobs only provide DATABASE_URL — do not parse app env / AUTH_SECRET. */
export async function runMigrateOpenWorkflowFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const connectionString = env.DATABASE_URL
  if (!connectionString) {
    throw new Error("DATABASE_URL is required")
  }
  await migrateOpenWorkflow(connectionString)
}

const invokedDirectly = process.argv[1]?.includes("migrate-openworkflow.ts")

if (invokedDirectly) {
  await runMigrateOpenWorkflowFromEnv()
}
