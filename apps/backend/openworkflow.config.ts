import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"

// Load env from config directory so worker has same vars as backend (bunx doesn't auto-load .env)
const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(__dirname, ".env.local") })
config({ path: resolve(__dirname, ".env") })

import { defineConfig } from "@openworkflow/cli"
import { BackendPostgres } from "openworkflow/postgres"
import { parseEnv } from "./src/config/env.js"
import { initDb } from "./src/db/client.js"
import {
  DB_STARTUP_CONNECTION_RETRY,
  withDbConnectionAcquisitionRetry,
} from "./src/db/transientDbRetry.js"
import {
  createLogger,
  flushEvlog,
  initEvlog,
} from "./src/observability/logger.js"
import { initOtel, shutdownOtel } from "./src/observability/otel.js"
import { parseOpenWorkflowConcurrency } from "./src/openworkflow/codesearchCapacity.js"
import { openWorkflowNamespaceId } from "./src/openworkflow/namespace.js"
import { backfillGithubAppSecretsFromEnv } from "./src/scripts/backfillGithubConnectionSecrets.js"

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error("DATABASE_URL is required for the worker")
initDb(databaseUrl, DB_STARTUP_CONNECTION_RETRY)
const env = parseEnv(process.env as Record<string, string | undefined>)
initOtel(env)
initEvlog()
await backfillGithubAppSecretsFromEnv(env)

let shuttingDown = false
async function shutdownWorkerObservability() {
  if (shuttingDown) return
  shuttingDown = true
  await Promise.all([flushEvlog(), shutdownOtel()])
}

process.on("SIGINT", () => {
  void shutdownWorkerObservability()
})
process.on("SIGTERM", () => {
  void shutdownWorkerObservability()
})

const workerConcurrency = parseOpenWorkflowConcurrency(
  process.env.OPENWORKFLOW_CONCURRENCY,
)

const bootstrapLog = createLogger({
  component: "openworkflow-worker",
  step: "openworkflow.config-loaded",
  pid: process.pid,
  cwd: process.cwd(),
  nodeEnv: process.env.NODE_ENV,
  concurrency: workerConcurrency,
})
bootstrapLog.info("openworkflow worker config loaded")
bootstrapLog.emit()

const backend = await withDbConnectionAcquisitionRetry(
  () =>
    BackendPostgres.connect(databaseUrl, {
      namespaceId: openWorkflowNamespaceId(),
    }),
  DB_STARTUP_CONNECTION_RETRY,
)

export default defineConfig({
  backend,
  dirs: ["./src/openworkflow/workflows"],
  // CLI imports every *.ts under dirs; skip Vitest files (dev-only deps).
  ignorePatterns: ["**/*.test.*", "**/*.spec.*"],
  worker: {
    concurrency: workerConcurrency,
  },
})
