// The one migrate entry point for hosted (deploy.yaml), Docker Compose, AWS CDK
// and local dev (scripts/db-migrate.sh). Run it with the owner DATABASE_URL.
// DATABASE_APP_PASSWORD is optional when ctxpipe_app exists already.
import { config } from "dotenv"

import { migrateKnowledgeStore } from "../knowledge-store/migrate.js"
import { flushEvlog, initEvlog, log } from "../observability/logger.js"
import { closeDb, initDb } from "./client.js"
import { describeMigrateError } from "./describe-migrate-error.js"
import { runMigrations } from "./run-migrations.js"
import { formatUnknownError } from "./transientDbRetry.js"

config({ path: ".env.local", quiet: true })
config({ path: ".env", quiet: true })
try {
  initEvlog()
} catch {
  // Hosted and CI migrate jobs give no app env (AUTH_SECRET). Logs then keep
  // the evlog defaults, and errors still go to stderr.
}

let exitCode = 0
try {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error("[migrate] DATABASE_URL is required")
  await runMigrations({
    connectionString,
    appRolePassword: process.env.DATABASE_APP_PASSWORD || undefined,
  })
  // Optional until the hosted ClickHouse node exists (ADR-066 decision 10).
  // Here CLICKHOUSE_URL is the admin user. The migration makes the reader user
  // of the backend and the writer user of the worker.
  const clickhouseUrl = process.env.CLICKHOUSE_URL
  if (clickhouseUrl)
    await migrateKnowledgeStore(clickhouseUrl, {
      reader: process.env.CLICKHOUSE_READER_PASSWORD || undefined,
      writer: process.env.CLICKHOUSE_WRITER_PASSWORD || undefined,
    })
  else
    log.info({
      step: "migrate",
      message: "[migrate] CLICKHOUSE_URL is not set: no ClickHouse migrations",
    })
  // Each deploy queues the knowledge plane backfill of each org (CTX-1643).
  // Thus a self-host needs no operator step. A failed backfill does not fail
  // the deploy: it logs, and the next deploy or hydrate queues the run again.
  await backfillAfterMigrate(connectionString)
  log.info({ step: "migrate", message: "[migrate] done" })
} catch (error) {
  exitCode = 1
  // The whole cause chain: the wrapped message alone hides the statement.
  const message = describeMigrateError(error)
  log.error({ step: "migrate", message: "[migrate] failed", error: message })
  const frames = (error instanceof Error ? (error.stack ?? "") : "")
    .split("\n")
    .filter((line) => line.trimStart().startsWith("at "))
  process.stderr.write(`${[message, ...frames].join("\n")}\n`)
}
await flushEvlog()
process.exit(exitCode)

async function backfillAfterMigrate(connectionString: string): Promise<void> {
  try {
    initDb(connectionString)
    // Dynamic imports: the OpenWorkflow client connects when it loads, and
    // its tables exist only after the migrations.
    const { backfillAllKnowledgePlanes } =
      await import("../knowledge-plane/backfill.js")
    const { closeOpenWorkflowClient } =
      await import("../openworkflow/client.js")
    try {
      await backfillAllKnowledgePlanes()
    } finally {
      await closeOpenWorkflowClient()
    }
  } catch (error) {
    log.error({
      step: "knowledge_plane.backfill_failed",
      message: "[migrate] the knowledge plane backfill failed",
      error: formatUnknownError(error),
    })
  } finally {
    await closeDb()
  }
}
