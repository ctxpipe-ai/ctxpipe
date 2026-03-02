import { defineConfig } from "@openworkflow/cli"
import { BackendPostgres } from "openworkflow/postgres"
import { initDb } from "./src/db/client.js"

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error("DATABASE_URL is required for the worker")
initDb(databaseUrl)

export default defineConfig({
  backend: await BackendPostgres.connect(databaseUrl),
  dirs: ["./src/openworkflow"],
})
