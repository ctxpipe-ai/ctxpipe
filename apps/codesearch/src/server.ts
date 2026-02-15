import type { Serve } from "bun"
import { createApp } from "./app/app.js"
import { parseEnv } from "./config/env.js"

const env = parseEnv(process.env as Record<string, string | undefined>)
const app = createApp(env)

export default {
  port: env.PORT,
  fetch: app.fetch,
} satisfies Serve.Options<undefined>
