import type { Serve } from "bun"
import { log } from "evlog"
import { createApp } from "./app/app.js"
import { parseEnv } from "./config/env.js"
import { closeDb } from "./db/client.js"
import { flushEvlog, initEvlog } from "./observability/logger.js"
import { initOtel, shutdownOtel } from "./observability/otel.js"
import { shutdownGraphClients } from "./platform/graph/index.js"
import {
  handleWebSocketProxy,
  type UiProxyWebSocketData,
  uiProxyWebSocketHandlers,
} from "./routes/ui.js"

const env = parseEnv(process.env as Record<string, string | undefined>)
initOtel(env)
initEvlog()
log.info({
  area: "server",
  action: "backend_bootstrap_complete",
  port: env.PORT,
  nodeEnv: env.NODE_ENV,
  langsmithEnabled: process.env.ENABLE_LANGSMITH === "true",
})
const app = createApp()
let shuttingDown = false

async function shutdownResources() {
  if (shuttingDown) return
  shuttingDown = true
  log.info({
    area: "server",
    action: "backend_shutdown_started",
  })
  try {
    await Promise.all([flushEvlog(), shutdownOtel()])
    await shutdownGraphClients()
    await closeDb()
    log.info({
      area: "server",
      action: "backend_shutdown_completed",
    })
  } catch (error) {
    log.error({
      area: "server",
      action: "backend_shutdown_failed",
      error:
        error instanceof Error ? error.message : "Unknown shutdown failure",
    })
  }
}

process.on("SIGINT", () => {
  void shutdownResources()
})

process.on("SIGTERM", () => {
  void shutdownResources()
})

const tls =
  env.NODE_ENV === "development"
    ? {
        cert: Bun.file("certs/localhost-cert.pem"),
        key: Bun.file("certs/localhost-key.pem"),
      }
    : {}

export default {
  port: env.PORT,
  idleTimeout: 255,
  fetch: (request, server) =>
    handleWebSocketProxy(request, server, env) || app.fetch(request, server),
  websocket: uiProxyWebSocketHandlers,
  tls,
} satisfies Serve.Options<UiProxyWebSocketData>
