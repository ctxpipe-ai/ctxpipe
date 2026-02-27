import type { Serve } from "bun"
import { createApp } from "./app/app.js"
import { parseEnv } from "./config/env.js"
import {
  handleWebSocketProxy,
  type UiProxyWebSocketData,
  uiProxyWebSocketHandlers,
} from "./routes/ui.js"

const env = parseEnv(process.env as Record<string, string | undefined>)
const app = createApp()

const tls =
  env.NODE_ENV === "development"
    ? {
        cert: Bun.file("certs/localhost-cert.pem"),
        key: Bun.file("certs/localhost-key.pem"),
      }
    : {}

export default {
  port: env.PORT,
  fetch: (request, server) =>
    handleWebSocketProxy(request, server, env) || app.fetch(request, server),
  websocket: uiProxyWebSocketHandlers,
  tls,
} satisfies Serve.Options<UiProxyWebSocketData>
