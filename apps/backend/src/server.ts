import type { Serve } from "bun"
import { createApp } from "./app/app.js"
import { parseEnv } from "./config/env.js"

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
  fetch: app.fetch,
  tls,
} satisfies Serve.Options<undefined>
