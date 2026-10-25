import type { Serve } from "bun"
import { createApp } from "./app/app.js"
import { parseEnv } from "./config/env.js"
import {
  CACHE_LAYOUT_MARKER,
  REPO_CACHE_DIR,
  ZOEKT_INDEX_DIR,
} from "./config/paths.js"
import { resetCacheForLayout } from "./domain/repositories/layoutReset.js"
import { flushEvlog, initEvlog } from "./observability/logger.js"
import { initOtel, shutdownOtel } from "./observability/otel.js"

const env = parseEnv(process.env as Record<string, string | undefined>)
initOtel()
initEvlog()
// Before the server takes a request: no read or index uses the cache yet.
await resetCacheForLayout({
  markerPath: CACHE_LAYOUT_MARKER,
  dirs: [REPO_CACHE_DIR, ZOEKT_INDEX_DIR],
})
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
