import { createApp } from "./app/app.js"
import { parseEnv } from "./config/env.js"

const env = parseEnv(process.env as Record<string, string | undefined>)
const app = createApp()

export default {
  port: env.PORT,
  fetch: app.fetch,
}
