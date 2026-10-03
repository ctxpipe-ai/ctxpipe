// Native subprocess fixture: the production codesearch app, its own pool, and HTTP listener.
import { writeFile } from "node:fs/promises"
import { initLogger } from "evlog"
import { createApp } from "../../../codesearch/src/app/app.js"

initLogger({ enabled: false })
const readyFile = process.argv[2]
if (!readyFile) throw new Error("A ready-file path is required")
const authSecret = process.env.AUTH_SECRET
if (!authSecret)
  throw new Error("AUTH_SECRET is required for the native service")
const app = createApp({
  DATABASE_URL: process.env.DATABASE_URL,
  AUTH_SECRET: authSecret,
  PORT: 0,
  NODE_ENV: "test",
})
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch })
await writeFile(readyFile, JSON.stringify({ port: server.port }))
process.once("SIGTERM", () => {
  server.stop(true)
  process.exit(0)
})
