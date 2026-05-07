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
import { createLogger, initEvlog } from "./src/observability/logger.js"
import { backfillGithubAppSecretsFromEnv } from "./src/scripts/backfillGithubConnectionSecrets.js"

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error("DATABASE_URL is required for the worker")
initDb(databaseUrl)
initEvlog()
const env = parseEnv(process.env as Record<string, string | undefined>)
await backfillGithubAppSecretsFromEnv(env)

const bootstrapLog = createLogger({
  component: "openworkflow-worker",
  step: "openworkflow.config-loaded",
  pid: process.pid,
  cwd: process.cwd(),
  nodeEnv: process.env.NODE_ENV,
})
bootstrapLog.info("openworkflow worker config loaded")
bootstrapLog.emit()

export default defineConfig({
  backend: await BackendPostgres.connect(databaseUrl),
  dirs: ["./src/openworkflow"],
  // CLI imports every *.ts under dirs; exclude infra, helpers, and tests (Vitest deps are dev-only).
  ignorePatterns: [
    "**/*.test.*",
    "**/*.spec.*",
    "src/openworkflow/worker-supervisor.ts",
    "src/openworkflow/railway-wake.ts",
    "src/openworkflow/client.ts",
    "src/openworkflow/enqueue-repository-ingestion.ts",
    "src/openworkflow/enqueue-confluence-push-sync.ts",
    "src/openworkflow/confluence-scope-repo-schema.ts",
  ],
})
