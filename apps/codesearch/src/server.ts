import type { Serve } from "bun"
import { createApp } from "./app/app.js"
import { parseEnv } from "./config/env.js"
import { assertRuntimeRoleDoesNotBypassRls } from "./db/assert-runtime-role.js"
import { initEvlog } from "./observability/logger.js"

initEvlog()

const env = parseEnv(process.env as Record<string, string | undefined>)
if (env.DATABASE_URL) {
  await assertRuntimeRoleDoesNotBypassRls(env.DATABASE_URL)
}
const app = createApp(env)

export default {
  port: env.PORT,
  fetch: app.fetch,
} satisfies Serve.Options<undefined>
