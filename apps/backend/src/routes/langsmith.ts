import type { Hono } from "hono"
import { proxy } from "hono/proxy"
import type { AppEnv } from "../app/env.js"
import { startLangSmithSubprocess } from "../langsmith/subprocess.js"

/**
 * Creates a proxy handler that forwards requests to the LangGraph dev server.
 * Strips the /langsmith prefix and forwards to the upstream.
 * Reads LANGSMITH_DEV_PORT from env (default 2024).
 */
export function registerLangsmithRoutes(app: Hono<AppEnv>) {
  console.log("registerLangsmithRoutes", process.env.ENABLE_LANGSMITH)
  if (process.env.ENABLE_LANGSMITH !== "true") return

  startLangSmithSubprocess()

  app.all("/langsmith/*", (c) => {
    const url = new URL(c.req.url)
    const path = url.pathname.slice("/langsmith".length) || "/"
    const upstreamRequest = new Request(
      `http://127.0.0.1:2024${path}${url.search}`,
      c.req.raw,
    )
    return proxy(upstreamRequest, {
      headers: {
        ...Object.fromEntries(c.req.raw.headers),
        "X-Forwarded-For": "127.0.0.1",
        "X-Forwarded-Host": c.req.header("host") ?? "localhost",
      },
    })
  })
}
