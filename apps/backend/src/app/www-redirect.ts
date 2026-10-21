import type { MiddlewareHandler } from "hono"

/** Send `www.app.ctxpipe.ai` to the canonical hosted origin, keeping path and query. */
export function wwwRedirect(): MiddlewareHandler {
  return async (c, next) => {
    const host = c.req.header("host")?.split(":")[0]?.toLowerCase()
    if (host !== "www.app.ctxpipe.ai") return next()
    const url = new URL(c.req.url)
    return c.redirect(`https://app.ctxpipe.ai${url.pathname}${url.search}`, 308)
  }
}
