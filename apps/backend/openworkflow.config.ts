import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"

// Load env from config directory so worker has same vars as backend (bunx doesn't auto-load .env).
// Base `.env` then `.env.local` with override so local wins; matches codesearch-docker-dev.sh.
const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(__dirname, ".env") })
config({ path: resolve(__dirname, ".env.local"), override: true })

import { defineConfig } from "@openworkflow/cli"
import { BackendPostgres } from "openworkflow/postgres"
import { initDb } from "./src/db/client.js"
import { createLogger, initEvlog } from "./src/observability/logger.js"

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error("DATABASE_URL is required for the worker")
initDb(databaseUrl)
initEvlog()

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
})
