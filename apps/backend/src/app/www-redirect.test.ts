import { Hono } from "hono"
import { describe, expect, it } from "vitest"
import { wwwRedirect } from "./www-redirect.js"

const app = new Hono()
app.use("*", wwwRedirect())
app.get("/*", (c) => c.text("ok"))

const call = (host: string, path: string) =>
  app.request(`http://${host}${path}`, { headers: { host } })

describe("wwwRedirect", () => {
  it("answers 308 to the app host with the same path and query", async () => {
    const res = await call("www.app.ctxpipe.ai", "/some/path?x=1&y=a%20b")
    expect(res.status).toBe(308)
    expect(res.headers.get("location")).toBe(
      "https://app.ctxpipe.ai/some/path?x=1&y=a%20b",
    )
  })

  it("redirects the root path", async () => {
    const res = await call("WWW.app.ctxpipe.ai", "/")
    expect(res.status).toBe(308)
    expect(res.headers.get("location")).toBe("https://app.ctxpipe.ai/")
  })

  it("passes other hosts through", async () => {
    for (const host of ["app.ctxpipe.ai", "localhost:3000"]) {
      const res = await call(host, "/some/path?x=1")
      expect(res.status).toBe(200)
      expect(await res.text()).toBe("ok")
    }
  })
})
