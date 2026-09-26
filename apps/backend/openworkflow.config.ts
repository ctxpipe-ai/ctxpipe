import "./src/observability/register.js"
import { defineConfig } from "@openworkflow/cli"
import { BackendPostgres } from "openworkflow/postgres"
import { parseEnv } from "./src/config/env.js"
import { initDb } from "./src/db/client.js"
import { createLogger, flushEvlog } from "./src/observability/logger.js"
import { shutdownOtel } from "./src/observability/otel.js"
import { parseOpenWorkflowConcurrency } from "./src/openworkflow/codesearchCapacity.js"
import { openWorkflowNamespaceId } from "./src/openworkflow/namespace.js"
import { backfillGithubAppSecretsFromEnv } from "./src/scripts/backfillGithubConnectionSecrets.js"

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error("DATABASE_URL is required for the worker")
initDb(databaseUrl)
const env = parseEnv(process.env as Record<string, string | undefined>)
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

export default defineConfig({
  backend: await BackendPostgres.connect(databaseUrl, {
    namespaceId: openWorkflowNamespaceId(),
  }),
  dirs: ["./src/openworkflow/workflows"],
  // CLI imports every *.ts under dirs; skip Vitest files (dev-only deps).
  ignorePatterns: ["**/*.test.*", "**/*.spec.*"],
  worker: {
    concurrency: workerConcurrency,
  },
})
