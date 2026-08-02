import type { Serve } from "bun"
import { createApp } from "./app/app.js"
import { parseEnv } from "./config/env.js"
import { initEvlog } from "./observability/logger.js"

initEvlog()

const env = parseEnv(process.env as Record<string, string | undefined>)
const app = createApp(env)

export default {
  port: env.PORT,
  fetch: app.fetch,
} satisfies Serve.Options<undefined>
