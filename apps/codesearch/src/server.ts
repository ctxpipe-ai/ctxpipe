import type { Serve } from "bun"
import { createApp } from "./app/app.js"
import { parseEnv } from "./config/env.js"
import { flushEvlog, initEvlog } from "./observability/logger.js"
import { initOtel, shutdownOtel } from "./observability/otel.js"

const env = parseEnv(process.env as Record<string, string | undefined>)
initOtel()
initEvlog()
const app = createApp(env)

async function shutdownResources() {
  try {
    await Promise.all([flushEvlog(), shutdownOtel()])
  } finally {
    process.exit(0)
  }
}

process.once("SIGINT", () => {
  void shutdownResources()
})

process.once("SIGTERM", () => {
  void shutdownResources()
})

export default {
  port: env.PORT,
  fetch: app.fetch,
} satisfies Serve.Options<undefined>
