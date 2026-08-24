import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres"
import { Pool } from "pg"
import { log } from "../observability/logger.js"

/**
 * Create LangGraph checkpoint tables as the table owner.
 * Runtime `PostgresSaver` must not call `setup()` — `CREATE SCHEMA` needs
 * database CREATE, which `ctxpipe_app` must not have.
 */
export async function migrateLanggraphCheckpoints(
  connectionString: string,
): Promise<void> {
  log.info({
    step: "migrate",
    message: "[migrate] running LangGraph checkpoint schema",
  })
  const pool = new Pool({ connectionString, max: 1 })
  try {
    const saver = new PostgresSaver(pool)
    await saver.setup()
  } finally {
    await pool.end()
  }
}

/** GitHub migrate jobs only provide DATABASE_URL — do not parse app env. */
export async function runMigrateLanggraphCheckpointsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const connectionString = env.DATABASE_URL
  if (!connectionString) {
    throw new Error("DATABASE_URL is required")
  }
  await migrateLanggraphCheckpoints(connectionString)
}

const invokedDirectly = process.argv[1]?.includes("migrate-checkpoints.ts")

if (invokedDirectly) {
  await runMigrateLanggraphCheckpointsFromEnv()
}
