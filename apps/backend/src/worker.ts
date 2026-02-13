import { createApp } from "./app/app.js"
import type { Env } from "./config/env.js"

export type WorkerEnv = Env & {
  // Cloudflare bindings (secrets, R2, etc.) can be extended here
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: unknown): Promise<Response> {
    const app = createApp()
    return app.fetch(request, env, ctx as Parameters<typeof app.fetch>[2])
  },
}
