import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"

// Load env from config directory so worker has same vars as backend (bunx doesn't auto-load .env)
const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(__dirname, ".env.local") })
config({ path: resolve(__dirname, ".env") })

import { defineConfig } from "@openworkflow/cli"
import { BackendPostgres } from "openworkflow/postgres"
import { initDb } from "./src/db/client.js"
import { initEvlog } from "./src/observability/logger.js"

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error("DATABASE_URL is required for the worker")
initDb(databaseUrl)
initEvlog()

export default defineConfig({
  backend: await BackendPostgres.connect(databaseUrl),
  dirs: ["./src/openworkflow"],
})
