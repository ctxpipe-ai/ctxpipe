import type { Serve } from "bun"
import { parseEnv } from "./config/env.js"
import { initOtel, shutdownOtel } from "./observability/otel.js"

const env = parseEnv(process.env as Record<string, string | undefined>)
// Register the tracer before app modules load so outgoing fetch is wrapped
// before any route captures the global.
initOtel(env)

const { createApp } = await import("./app/app.js")
const { flushEvlog, initEvlog } = await import("./observability/logger.js")

initEvlog()
const app = createApp(env)
let shuttingDown = false

async function shutdownResources() {
  if (shuttingDown) return
  shuttingDown = true
  await Promise.all([flushEvlog(), shutdownOtel()])
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
