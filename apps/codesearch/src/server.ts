import type { Serve } from "bun"
import { createApp } from "./app/app.js"
import { parseEnv } from "./config/env.js"
import { flushEvlog, initEvlog } from "./observability/logger.js"
import { initOtel, shutdownOtel } from "./observability/otel.js"
import { shutdownAndExit } from "./observability/shutdownAndExit.js"

const env = parseEnv(process.env as Record<string, string | undefined>)
initOtel(env)
initEvlog()
const app = createApp(env)
let shuttingDown = false

async function shutdownResources() {
  if (shuttingDown) return
  shuttingDown = true
  await shutdownAndExit(async () => {
    await Promise.all([flushEvlog(), shutdownOtel()])
  })
}

process.on("SIGINT", () => {
  void shutdownResources()
})

process.on("SIGTERM", () => {
  void shutdownResources()
})

export default {
  port: env.PORT,
  fetch: app.fetch,
} satisfies Serve.Options<undefined>
